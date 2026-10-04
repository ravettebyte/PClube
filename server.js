const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
const DATABASE = path.join(ROOT, 'usuarios.json');
const MAX_BODY = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const PASSWORD_ITERATIONS = 310_000;
const SESSION_TTL = 14 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const presence = new Map();
const videoHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const dramaGenres = new Set(['Ação', 'Aventura', 'Comédia', 'Crime', 'Drama', 'Fantasia', 'Ficção científica', 'Histórico', 'Mistério', 'Romance', 'Suspense', 'Terror', 'Vida escolar']);
const seedAccounts = [
  ['membro01', 'Membro 01', 'RoxoClube#01'], ['membro02', 'Membro 02', 'RoxoClube#02'],
  ['membro03', 'Membro 03', 'RoxoClube#03'], ['membro04', 'Membro 04', 'RoxoClube#04'],
  ['membro05', 'Membro 05', 'RoxoClube#05'], ['membro06', 'Membro 06', 'RoxoClube#06'],
  ['membro07', 'Membro 07', 'RoxoClube#07'], ['membro08', 'Membro 08', 'RoxoClube#08'],
  ['membro09', 'Membro 09', 'RoxoClube#09'], ['membro10', 'Membro 10', 'RoxoClube#10'],
];

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function emptyDatabase() { return { users: {}, episodes: [], series: {}, recommendations: [] }; }

function loadDatabase() {
  let database;
  try {
    const raw = fs.existsSync(DATABASE) ? fs.readFileSync(DATABASE, 'utf8') : '';
    database = raw.trim() ? JSON.parse(raw) : emptyDatabase();
  } catch { throw new ApiError(500, 'Formato inválido no arquivo usuarios.json.'); }
  if (!database || typeof database !== 'object' || Array.isArray(database)
      || !database.users || typeof database.users !== 'object' || Array.isArray(database.users)
      || !Array.isArray(database.episodes)) throw new ApiError(500, 'Formato inválido no arquivo usuarios.json.');
  if (!database.series || typeof database.series !== 'object' || Array.isArray(database.series)) database.series = {};
  if (!Array.isArray(database.recommendations)) database.recommendations = [];
  if (!Object.keys(database.users).length) {
    for (const [username, display_name, password] of seedAccounts) {
      const id = crypto.randomUUID();
      database.users[id] = { id, username, display_name, bio: '', avatar: '', password: passwordRecord(password), created: Date.now() };
    }
    saveDatabase(database);
  }
  return database;
}

function saveDatabase(database) {
  const temporary = path.join(ROOT, `.usuarios-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, DATABASE);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function publicUser(user) {
  return Object.fromEntries(['id', 'username', 'display_name', 'bio', 'avatar', 'created'].map(key => [key, user[key] ?? '']));
}

function cleanText(value, maximum, required = false) {
  if (typeof value !== 'string') throw new ApiError(400, 'Revise os campos de texto enviados.');
  const result = value.trim();
  if (required && !result) throw new ApiError(400, 'Preencha todos os campos obrigatórios.');
  if (result.length > maximum) throw new ApiError(400, `O texto deve ter no máximo ${maximum} caracteres.`);
  return result;
}

function validateImage(value) {
  if (value == null || value === '') return '';
  const prefixes = ['data:image/jpeg;base64,', 'data:image/png;base64,', 'data:image/webp;base64,'];
  if (typeof value !== 'string' || !prefixes.some(prefix => value.startsWith(prefix))) throw new ApiError(400, 'A imagem deve ser JPG, PNG ou WebP.');
  const encoded = value.slice(value.indexOf(',') + 1);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new ApiError(400, 'A imagem enviada é inválida.');
  if (Buffer.from(encoded, 'base64').length > MAX_IMAGE_BYTES) throw new ApiError(400, 'A imagem pode ter no máximo 3 MB.');
  return value;
}

function validateVideoUrl(value) {
  const url = cleanText(value, 500, true);
  let parsed;
  try { parsed = new URL(url); } catch { throw new ApiError(400, 'Use um link HTTPS do YouTube ou de um vídeo direto.'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname) throw new ApiError(400, 'Use um link HTTPS do YouTube ou de um vídeo direto.');
  if (videoHosts.has(parsed.hostname.toLowerCase())) {
    let id = parsed.hostname.toLowerCase() === 'youtu.be' ? parsed.pathname.split('/')[1] || '' : parsed.searchParams.get('v') || '';
    if (!id) id = parsed.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})(?:\/|$)/)?.[1] || '';
    if (!/^[\w-]{11}$/.test(id)) throw new ApiError(400, 'Use um link direto de vídeo do YouTube, Shorts ou transmissão.');
    return url;
  }
  if (!['.mp4', '.webm', '.ogg'].includes(path.extname(parsed.pathname).toLowerCase())) throw new ApiError(400, 'O link direto deve apontar para um arquivo .mp4, .webm ou .ogg.');
  return url;
}

function passwordRecord(password) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('hex') };
}

function passwordMatches(password, record) {
  try {
    const expected = Buffer.from(record.hash, 'hex');
    const actual = crypto.pbkdf2Sync(password, Buffer.from(record.salt, 'hex'), PASSWORD_ITERATIONS, 32, 'sha256');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL });
  return token;
}

function sessionUser(request, database) {
  const token = (request.headers.cookie || '').split(';').map(item => item.trim())
    .find(item => item.startsWith('clube_session='))?.slice('clube_session='.length);
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) { sessions.delete(token); return null; }
  presence.set(session.userId, Date.now());
  return database.users[session.userId] || null;
}

function requireUser(request, database) {
  const user = sessionUser(request, database);
  if (!user) throw new ApiError(401, 'Entre na sua conta para continuar.');
  return user;
}

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ApiError(400, 'O servidor espera dados no formato JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(400, 'A requisição está vazia ou excede o limite de 5 MB.');
    chunks.push(chunk);
  }
  if (!size) throw new ApiError(400, 'A requisição está vazia ou excede o limite de 5 MB.');
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Não foi possível interpretar os dados enviados.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ApiError(400, 'O corpo da requisição deve ser um objeto JSON.');
  return payload;
}

function sendJson(response, status, data, token = null) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...(token ? { 'Set-Cookie': `clube_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}` } : {}),
  });
  response.end(JSON.stringify(data));
}

function sendFile(response, name, contentType) {
  const filename = path.resolve(ROOT, name);
  if (!filename.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return sendJson(response, 404, { error: 'Página não encontrada.' });
  response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  fs.createReadStream(filename).pipe(response);
}

function intValue(value, message) {
  if (!Number.isInteger(value)) throw new ApiError(400, message);
  return value;
}

function normalize(value) { return value.trim().toLocaleLowerCase('pt-BR'); }
function findEpisode(database, id) { return database.episodes.find(item => item.id === id) || null; }
function decodePath(value) { try { return decodeURIComponent(value); } catch { throw new ApiError(400, 'Endereço inválido.'); } }

function updateDisplayLabel(database, series, value) {
  if (value === undefined) return;
  const label = cleanText(value, 40);
  if (!['', 'Girls Lovers', 'Boys Lovers'].includes(label)) throw new ApiError(400, 'Escolha uma categoria válida para o bloco.');
  const key = normalize(series);
  const metadata = database.series[key] ||= {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new ApiError(400, 'Os dados deste dorama estão inválidos.');
  if (label) metadata.display_label = label;
  else delete metadata.display_label;
}

function login(request, response, payload) {
  const username = cleanText(payload.username, 24, true).toLowerCase();
  const password = cleanText(payload.password, 256, true);
  const database = loadDatabase();
  const user = Object.values(database.users).find(item => item.username === username);
  if (!user || !passwordMatches(password, user.password)) throw new ApiError(401, 'Usuário ou senha incorretos.');
  sendJson(response, 200, { me: publicUser(user) }, createSession(user.id));
}

function register(request, response, payload) {
  const displayName = cleanText(payload.display_name, 50, true);
  const username = cleanText(payload.username, 24, true).toLowerCase();
  const password = cleanText(payload.password, 256, true);
  if (!/^[a-z0-9_.-]{3,24}$/.test(username)) throw new ApiError(400, 'O usuário deve ter 3–24 caracteres: letras, números, ponto, hífen ou sublinhado.');
  if (password.length < 10) throw new ApiError(400, 'A senha deve ter pelo menos 10 caracteres.');
  const database = loadDatabase();
  if (Object.values(database.users).some(item => item.username === username)) throw new ApiError(400, 'Esse nome de usuário já está em uso.');
  const id = crypto.randomUUID();
  const user = { id, username, display_name: displayName, bio: '', avatar: '', password: passwordRecord(password), created: Date.now() };
  database.users[id] = user;
  saveDatabase(database);
  sendJson(response, 201, { me: publicUser(user) }, createSession(id));
}

function logout(request, response) {
  for (const part of (request.headers.cookie || '').split(';')) if (part.trim().startsWith('clube_session=')) sessions.delete(part.trim().slice('clube_session='.length));
  response.setHeader('Set-Cookie', 'clube_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  sendJson(response, 200, {});
}

function addEpisode(request, response, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const season = intValue(payload.season ?? 0, 'Temporada e episódio devem ser números.');
  const number = intValue(payload.episode_number ?? payload.episode ?? 0, 'Temporada e episódio devem ser números.');
  if (season < 1 || season > 999 || number < 1 || number > 9999) throw new ApiError(400, 'Informe uma temporada e um episódio válidos.');
  const episode = {
    id: crypto.randomUUID(), series: cleanText(payload.series, 80, true), season, episode_number: number,
    title: cleanText(payload.title, 120, true), description: cleanText(payload.description ?? '', 2000),
    video_url: validateVideoUrl(payload.video_url), cover: validateImage(payload.cover), added_by: user.id,
    created: Date.now(), progress: {}, comments: [],
  };
  database.episodes.unshift(episode);
  updateDisplayLabel(database, episode.series, payload.display_label);
  saveDatabase(database);
  sendJson(response, 201, { episode });
}

function updateEpisode(request, response, id, payload) {
  const database = loadDatabase();
  requireUser(request, database);
  const episode = findEpisode(database, id);
  if (!episode) throw new ApiError(404, 'Esse episódio não existe.');
  const oldKey = normalize(episode.series);
  const series = cleanText(payload.series, 80, true);
  const season = intValue(payload.season ?? episode.season, 'Temporada e episódio devem ser números.');
  const number = intValue(payload.episode_number ?? payload.episode ?? episode.episode_number, 'Temporada e episódio devem ser números.');
  if (season < 1 || season > 999 || number < 1 || number > 9999) throw new ApiError(400, 'Informe uma temporada e um episódio válidos.');
  Object.assign(episode, { series, season, episode_number: number, title: cleanText(payload.title, 120, true),
    description: cleanText(payload.description ?? '', 2000), video_url: validateVideoUrl(payload.video_url) });
  if (Object.hasOwn(payload, 'cover')) episode.cover = validateImage(payload.cover);
  const newKey = normalize(series);
  if (oldKey !== newKey && Object.hasOwn(database.series, oldKey)) { database.series[newKey] = database.series[oldKey]; delete database.series[oldKey]; }
  updateDisplayLabel(database, series, payload.display_label);
  saveDatabase(database);
  sendJson(response, 200, { episode });
}

function deleteEpisode(request, response, id) {
  const database = loadDatabase();
  requireUser(request, database);
  if (!findEpisode(database, id)) throw new ApiError(404, 'Esse episódio não existe.');
  database.episodes = database.episodes.filter(item => item.id !== id);
  saveDatabase(database);
  sendJson(response, 200, { deleted: true });
}

function deleteSeries(request, response, name) {
  const database = loadDatabase();
  requireUser(request, database);
  const key = normalize(name);
  if (!database.episodes.some(item => normalize(item.series) === key)) throw new ApiError(404, 'Esse dorama não existe.');
  database.episodes = database.episodes.filter(item => normalize(item.series) !== key);
  delete database.series[key];
  saveDatabase(database);
  sendJson(response, 200, { deleted: true });
}

function updateProgress(request, response, id, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const episode = findEpisode(database, id);
  if (!episode) throw new ApiError(404, 'Esse episódio não existe.');
  if (!['new', 'watching', 'done'].includes(payload.status)) throw new ApiError(400, 'Escolha um status válido para o episódio.');
  episode.progress ||= {};
  const mine = episode.progress[user.id] ||= {};
  Object.assign(mine, { status: payload.status, note: cleanText(payload.note ?? '', 120) });
  saveDatabase(database);
  sendJson(response, 200, { progress: mine });
}

function recordEpisodeOpen(request, response, id) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const episode = findEpisode(database, id);
  if (!episode) throw new ApiError(404, 'Esse episódio não existe.');
  episode.progress ||= {};
  const mine = episode.progress[user.id] ||= { status: 'new', note: '' };
  mine.last_opened = Date.now();
  saveDatabase(database);
  sendJson(response, 200, { progress: mine });
}

function addComment(request, response, id, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const episode = findEpisode(database, id);
  if (!episode) throw new ApiError(404, 'Esse episódio não existe.');
  const requested = payload.mentions ?? [];
  if (!Array.isArray(requested) || requested.length > 20) throw new ApiError(400, 'A lista de marcações é inválida.');
  const allowed = new Set(Object.keys(database.users).filter(userId => userId !== user.id));
  const mentions = [...new Set(requested.filter(value => typeof value === 'string' && allowed.has(value)))];
  episode.comments ||= [];
  episode.comments.push({ id: crypto.randomUUID(), user_id: user.id, text: cleanText(payload.text, 1000, true), mentions, created: Date.now() });
  saveDatabase(database);
  sendJson(response, 201, { comments: episode.comments });
}

function updateSeries(request, response, name, action, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const key = normalize(name);
  if (!database.episodes.some(item => normalize(item.series) === key)) throw new ApiError(404, 'Esse dorama não existe.');
  const drama = database.series[key] ||= { background_url: '', genres: {}, ratings: {}, comments: [], favorites: {} };
  drama.genres ||= {}; drama.ratings ||= {}; drama.comments ||= []; drama.favorites ||= {};
  if (action === 'preferences') {
    if (Object.hasOwn(payload, 'genres')) {
      if (!Array.isArray(payload.genres) || payload.genres.length > 3 || payload.genres.some(genre => !dramaGenres.has(genre))) throw new ApiError(400, 'Escolha no máximo três gêneros válidos.');
      drama.genres[user.id] = [...new Set(payload.genres)];
    }
    if (Object.hasOwn(payload, 'rating')) {
      if (payload.rating === null) delete drama.ratings[user.id];
      else {
        const rating = intValue(payload.rating, 'A nota deve ser de uma a cinco estrelas.');
        if (rating < 1 || rating > 5) throw new ApiError(400, 'A nota deve ser de uma a cinco estrelas.');
        drama.ratings[user.id] = rating;
      }
    }
  } else if (action === 'background') {
    const background = cleanText(payload.background_url ?? '', 500);
    drama.background_url = background ? validateVideoUrl(background) : '';
  } else if (action === 'comments') {
    drama.comments.push({ id: crypto.randomUUID(), user_id: user.id, text: cleanText(payload.text, 1000, true), created: Date.now() });
  } else if (action === 'favorite') {
    if (typeof payload.favorite !== 'boolean') throw new ApiError(400, 'A escolha de favorito é inválida.');
    if (payload.favorite) drama.favorites[user.id] = true; else delete drama.favorites[user.id];
  }
  saveDatabase(database);
  sendJson(response, 200, { series: drama });
}

function updateProfile(request, response, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const username = cleanText(payload.username ?? user.username, 24, true).toLowerCase();
  if (!/^[a-z0-9_.-]{3,24}$/.test(username)) throw new ApiError(400, 'O usuário deve ter 3–24 caracteres: letras, números, ponto, hífen ou sublinhado.');
  if (Object.values(database.users).some(item => item.id !== user.id && item.username === username)) throw new ApiError(400, 'Esse nome de usuário já está em uso.');
  const displayName = cleanText(payload.display_name, 50, true);
  const bio = cleanText(payload.bio ?? '', 280);
  const avatar = validateImage(payload.avatar);
  const current = payload.current_password ?? '';
  const next = payload.new_password ?? '';
  if (typeof current !== 'string' || typeof next !== 'string') throw new ApiError(400, 'Revise os campos de texto enviados.');
  if (Boolean(current) !== Boolean(next)) throw new ApiError(400, 'Informe a senha atual e a nova senha para alterar a senha.');
  if (next) {
    if (!passwordMatches(current, user.password)) throw new ApiError(400, 'A senha atual está incorreta.');
    if (next.length < 10) throw new ApiError(400, 'A nova senha deve ter pelo menos 10 caracteres.');
    user.password = passwordRecord(next);
  }
  user.username = username; user.display_name = displayName; user.bio = bio;
  if (avatar) user.avatar = avatar;
  saveDatabase(database);
  sendJson(response, 200, { me: publicUser(user) });
}

function handleRecommendation(request, response, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const series = cleanText(payload.series, 80, true);
  if (typeof payload.to_user_id !== 'string' || !Object.hasOwn(database.users, payload.to_user_id)) throw new ApiError(400, 'Selecione um membro válido para receber a recomendação.');
  if (payload.to_user_id === user.id) throw new ApiError(400, 'Você não pode recomendar para si mesmo.');
  if (!database.episodes.some(item => item.series.trim().toLowerCase() === series.toLowerCase())) throw new ApiError(400, 'Esse dorama não existe na biblioteca.');
  const recommendation = { id: crypto.randomUUID(), from_user_id: user.id, to_user_id: payload.to_user_id, series, created: Date.now(), read: false };
  database.recommendations.push(recommendation);
  saveDatabase(database);
  sendJson(response, 201, { recommendation });
}

async function handle(request, response) {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html') return sendFile(response, 'index.html', 'text/html; charset=utf-8');
      if (pathname === '/style.css') return sendFile(response, 'style.css', 'text/css; charset=utf-8');
      if (pathname === '/IMAGENS/logo.png') return sendFile(response, 'IMAGENS/logo.png', 'image/png');
      if (pathname === '/api/me') {
        const database = loadDatabase(); const user = sessionUser(request, database);
        return sendJson(response, 200, { me: user ? publicUser(user) : null });
      }
      if (pathname === '/api/data') {
        const database = loadDatabase(); const user = requireUser(request, database);
        const users = Object.values(database.users).map(item => ({ ...publicUser(item), online: Date.now() - (presence.get(item.id) || 0) < 45_000 }));
        return sendJson(response, 200, { me: publicUser(user), users, episodes: database.episodes, series: database.series, recommendations: database.recommendations });
      }
      return sendJson(response, 404, { error: 'Página não encontrada.' });
    }
    if (!['POST', 'PUT', 'DELETE'].includes(request.method)) return sendJson(response, 405, { error: 'Método não permitido.' });
    const payload = request.method === 'DELETE' ? {} : await readJson(request);
    if (request.method === 'POST') {
      if (pathname === '/api/login') return login(request, response, payload);
      if (pathname === '/api/register') return register(request, response, payload);
      if (pathname === '/api/logout') return logout(request, response);
      if (pathname === '/api/episodes') return addEpisode(request, response, payload);
      if (pathname === '/api/profile') return updateProfile(request, response, payload);
      let match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)\/progress$/);
      if (match) return updateProgress(request, response, match[1], payload);
      match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)\/open$/);
      if (match) return recordEpisodeOpen(request, response, match[1]);
      match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)\/comments$/);
      if (match) return addComment(request, response, match[1], payload);
      match = pathname.match(/^\/api\/series\/([^/]+)\/(preferences|comments|background|favorite)$/);
      if (match) return updateSeries(request, response, decodePath(match[1]), match[2], payload);
      if (pathname === '/api/recommendations') return handleRecommendation(request, response, payload);
    } else if (request.method === 'PUT') {
      const match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)$/);
      if (match) return updateEpisode(request, response, match[1], payload);
    } else {
      let match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)$/);
      if (match) return deleteEpisode(request, response, match[1]);
      match = pathname.match(/^\/api\/series\/(.+)$/);
      if (match) return deleteSeries(request, response, decodePath(match[1]));
    }
    return sendJson(response, 404, { error: 'Ação não encontrada.' });
  } catch (error) {
    if (response.headersSent) return response.destroy(error);
    if (error instanceof ApiError) return sendJson(response, error.status, { error: error.message });
    console.error(error);
    return sendJson(response, 500, { error: 'Não foi possível completar esta ação.' });
  }
}

loadDatabase();
const server = http.createServer(handle);
server.listen(8000, '127.0.0.1', () => {
  console.log('Clube do Episódio disponível em http://127.0.0.1:8000');
  console.log('Para sair, pressione Ctrl+C.');
});