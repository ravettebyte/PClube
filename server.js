const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
const DATABASE = path.join(ROOT, 'usuarios.json');
const DATA_ROOT = path.join(ROOT, 'dados');
const DATA_FILES = {
  schema: path.join(DATA_ROOT, 'configuracao.json'),
  users: path.join(DATA_ROOT, 'usuarios', 'usuarios.json'),
  episodes: path.join(DATA_ROOT, 'biblioteca', 'episodios.json'),
  series: path.join(DATA_ROOT, 'biblioteca', 'doramas.json'),
  messages: path.join(DATA_ROOT, 'mensagens', 'mensagens.json'),
  recommendations: path.join(DATA_ROOT, 'recomendacoes', 'recomendacoes.json'),
  watch_sessions: path.join(DATA_ROOT, 'sessoes', 'assistir-juntos.json'),
  activity: path.join(DATA_ROOT, 'notificacoes', 'atividade.json'),
};
const PROFILE_PHOTOS = path.join(DATA_ROOT, 'fotos', 'perfis');
const COVER_PHOTOS = path.join(DATA_ROOT, 'fotos', 'capas');
const PROFILE_ELEMENTS = path.join(DATA_ROOT, 'fotos', 'elementos');
const CHAT_ATTACHMENTS = path.join(DATA_ROOT, 'fotos', 'chat');
const MAX_BODY = 40 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const CHAT_STORAGE_LIMIT_BYTES = Number(process.env.PCLUBE_CHAT_STORAGE_LIMIT_BYTES || 50 * 1024 * 1024);
if (!Number.isSafeInteger(CHAT_STORAGE_LIMIT_BYTES) || CHAT_STORAGE_LIMIT_BYTES < 1) {
  throw new Error('PCLUBE_CHAT_STORAGE_LIMIT_BYTES deve ser um número inteiro positivo.');
}
const PASSWORD_ITERATIONS = 310_000;
const SESSION_TTL = 14 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const presence = new Map();
const chatTyping = new Map();
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

function emptyDatabase() { return { users: {}, episodes: [], series: {}, recommendations: [], messages: [], watch_sessions: [], activity: [] }; }

function loadDatabase() {
  let database;
  try {
    if (fs.existsSync(DATA_FILES.schema)) {
      database = {
        users: readDataFile(DATA_FILES.users),
        episodes: readDataFile(DATA_FILES.episodes),
        series: readDataFile(DATA_FILES.series),
        messages: readDataFile(DATA_FILES.messages),
        recommendations: readDataFile(DATA_FILES.recommendations),
        watch_sessions: readDataFile(DATA_FILES.watch_sessions),
        activity: readDataFile(DATA_FILES.activity),
      };
    } else {
      const raw = fs.existsSync(DATABASE) ? fs.readFileSync(DATABASE, 'utf8') : '';
      database = raw.trim() ? JSON.parse(raw) : emptyDatabase();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, 'Não foi possível ler os dados organizados em dados/. Verifique os arquivos JSON.');
  }
  if (!database || typeof database !== 'object' || Array.isArray(database)
      || !database.users || typeof database.users !== 'object' || Array.isArray(database.users)
      || !Array.isArray(database.episodes)) throw new ApiError(500, 'Formato inválido nos dados de usuários ou episódios.');
  if (!database.series || typeof database.series !== 'object' || Array.isArray(database.series)) database.series = {};
  if (!Array.isArray(database.recommendations)) database.recommendations = [];
  if (!Array.isArray(database.messages)) database.messages = [];
  if (!Array.isArray(database.watch_sessions)) database.watch_sessions = [];
  if (!Array.isArray(database.activity)) database.activity = [];
  if (!fs.existsSync(DATA_FILES.schema)) {
    migrateImages(database);
    saveDatabase(database);
    if (fs.existsSync(DATABASE)) {
      const backup = path.join(DATA_ROOT, 'migracao', `usuarios-${Date.now()}.json`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(DATABASE, backup);
    }
  }
  if (!Object.keys(database.users).length) {
    for (const [index, [username, display_name, password]] of seedAccounts.entries()) {
      const id = crypto.randomUUID();
      database.users[id] = { id, username, display_name, bio: '', avatar: '', role:index === 0 ? 'admin' : 'member', password: passwordRecord(password), created: Date.now() };
    }
    saveDatabase(database);
  }
  for (const user of Object.values(database.users)) {
    if (!['admin','moderator','member'].includes(user.role)) user.role = 'member';
  }
  if (!Object.values(database.users).some(user => user.role === 'admin')) {
    const firstUser = Object.values(database.users).sort((a,b) => Number(a.created || 0) - Number(b.created || 0))[0];
    if (firstUser) firstUser.role = 'admin';
    saveDatabase(database);
  }
  return database;
}

function readDataFile(filename) {
  if (!fs.existsSync(filename)) throw new ApiError(500, `Está faltando o arquivo de dados ${path.relative(DATA_ROOT, filename)}.`);
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new ApiError(500, `Formato inválido no arquivo ${path.relative(DATA_ROOT, filename)}.`); }
}

function writeJsonFile(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function imageExtension(mimeType) {
  return ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'})[mimeType];
}

const chatAttachmentTypes = new Map([
  ['image/jpeg',{extension:'jpg',inline:true,maximum:12*1024*1024}],
  ['image/png',{extension:'png',inline:true,maximum:12*1024*1024}],
  ['image/webp',{extension:'webp',inline:true,maximum:12*1024*1024}],
  ['image/gif',{extension:'gif',inline:true,maximum:12*1024*1024}],
  ['video/mp4',{extension:'mp4',inline:true,maximum:15*1024*1024}],
  ['video/webm',{extension:'webm',inline:true,maximum:15*1024*1024}],
  ['audio/mpeg',{extension:'mp3',inline:true,maximum:12*1024*1024}],
  ['audio/mp4',{extension:'m4a',inline:true,maximum:12*1024*1024}],
  ['audio/ogg',{extension:'ogg',inline:true,maximum:12*1024*1024}],
  ['audio/wav',{extension:'wav',inline:true,maximum:12*1024*1024}],
  ['application/pdf',{extension:'pdf',inline:true,maximum:2*1024*1024}],
  ['text/plain',{extension:'txt',inline:true,maximum:2*1024*1024}],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document',{extension:'docx',inline:false,maximum:2*1024*1024}],
]);

function storeChatAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) throw new ApiError(400, 'Envie no máximo três arquivos por mensagem.');
  let totalBytes = 0;
  const attachments = value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.data !== 'string' || typeof item.type !== 'string') {
      throw new ApiError(400, 'Um dos arquivos enviados está inválido.');
    }
    const type = chatAttachmentTypes.get(item.type);
    if (!type) throw new ApiError(400, 'Use imagens, PDF, texto ou documentos DOCX no bate-papo.');
    const prefix = `data:${item.type};base64,`;
    if (!item.data.startsWith(prefix)) throw new ApiError(400, 'O conteúdo de um arquivo está inválido.');
    const encoded = item.data.slice(prefix.length);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new ApiError(400, 'O conteúdo de um arquivo está inválido.');
    }
    const contents = Buffer.from(encoded, 'base64');
    if (!contents.length || contents.length > Math.min(MAX_CHAT_ATTACHMENT_BYTES, type.maximum)) {
      throw new ApiError(400, `O arquivo ${item.name || ''} excede o limite permitido para esse formato.`);
    }
    totalBytes += contents.length;
    if (totalBytes > 20 * 1024 * 1024) throw new ApiError(400, 'O tamanho total dos anexos não pode passar de 20 MB.');
    const name = cleanText(item.name, 120, true).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    const hash = crypto.createHash('sha256').update(contents).digest('hex');
    const filename = `${hash}.${type.extension}`;
    fs.mkdirSync(CHAT_ATTACHMENTS, {recursive:true});
    const target = path.join(CHAT_ATTACHMENTS, filename);
    if (!fs.existsSync(target)) fs.writeFileSync(target, contents, {flag:'wx'});
    return {url:`/media/chat/${filename}`,name,type:item.type,size:contents.length};
  });
  return attachments;
}

function storeImage(value, kind) {
  const checked = validateImage(value);
  if (!checked) return '';
  if (checked.startsWith('/media/')) return checked;
  const comma = checked.indexOf(',');
  const mimeType = checked.slice(5, checked.indexOf(';'));
  const contents = Buffer.from(checked.slice(comma + 1), 'base64');
  const hash = crypto.createHash('sha256').update(contents).digest('hex');
  const extension = imageExtension(mimeType);
  const directory = kind === 'profile' ? PROFILE_PHOTOS : kind === 'element' ? PROFILE_ELEMENTS : COVER_PHOTOS;
  const relative = kind === 'profile' ? 'perfis' : kind === 'element' ? 'elementos' : 'capas';
  const filename = `${hash}.${extension}`;
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, filename);
  if (!fs.existsSync(target)) fs.writeFileSync(target, contents, { flag: 'wx' });
  return `/media/${relative}/${filename}`;
}

function migrateImages(database) {
  for (const user of Object.values(database.users)) {
    if (typeof user.avatar === 'string' && user.avatar.startsWith('data:image/')) user.avatar = storeImage(user.avatar, 'profile');
  }
  const migratedCovers = new Map();
  for (const episode of database.episodes) {
    if (typeof episode.cover !== 'string' || !episode.cover.startsWith('data:image/')) continue;
    if (!migratedCovers.has(episode.cover)) migratedCovers.set(episode.cover, storeImage(episode.cover, 'cover'));
    episode.cover = migratedCovers.get(episode.cover);
  }
}

function saveDatabase(database) {
  fs.mkdirSync(PROFILE_PHOTOS, { recursive: true });
  fs.mkdirSync(COVER_PHOTOS, { recursive: true });
  fs.mkdirSync(PROFILE_ELEMENTS, { recursive: true });
  writeJsonFile(DATA_FILES.users, database.users);
  writeJsonFile(DATA_FILES.episodes, database.episodes);
  writeJsonFile(DATA_FILES.series, database.series);
  writeJsonFile(DATA_FILES.messages, database.messages);
  writeJsonFile(DATA_FILES.recommendations, database.recommendations);
  writeJsonFile(DATA_FILES.watch_sessions, database.watch_sessions);
  writeJsonFile(DATA_FILES.activity, database.activity || []);
  writeJsonFile(DATA_FILES.schema, { version: 1, updated: Date.now() });
}

function chatStorageStatus(database) {
  const attachmentBytes = database.messages.reduce((total, message) =>
    total + (message.attachments || []).reduce((sum, attachment) => sum + (Number(attachment.size) || 0), 0), 0);
  const usedBytes = Buffer.byteLength(JSON.stringify({
    messages:database.messages,
    watch_sessions:database.watch_sessions,
  })) + attachmentBytes;
  return {
    used_bytes:usedBytes,
    limit_bytes:CHAT_STORAGE_LIMIT_BYTES,
    warning:usedBytes >= CHAT_STORAGE_LIMIT_BYTES * 0.8,
  };
}

function requireChatStorage(database) {
  if (chatStorageStatus(database).used_bytes >= CHAT_STORAGE_LIMIT_BYTES) {
    throw new ApiError(507, 'O espaço reservado para conversas e solicitações foi atingido. Apague mensagens antigas para continuar.');
  }
}

function cleanupChatStorage(database) {
  const targetBytes = Math.floor(CHAT_STORAGE_LIMIT_BYTES * 0.65);
  const removed = {messages:0,requests:0};
  while (database.messages.length && chatStorageStatus(database).used_bytes > targetBytes) {
    database.messages.shift();
    removed.messages++;
  }
  if (chatStorageStatus(database).used_bytes > targetBytes) {
    const endedSessions = database.watch_sessions.filter(session => session.ended)
      .sort((a, b) => Number(a.created) - Number(b.created));
    while (endedSessions.length && chatStorageStatus(database).used_bytes > targetBytes) {
      const session = endedSessions.shift();
      database.watch_sessions = database.watch_sessions.filter(item => item.id !== session.id);
      removed.requests++;
    }
  }
  const referencedFiles = new Set(database.messages.flatMap(message => (message.attachments || [])
    .map(attachment => path.basename(attachment.url || ''))
    .filter(filename => /^[a-f0-9]{64}\.(?:jpg|png|webp|gif|mp4|webm|mp3|m4a|ogg|wav|pdf|txt|docx)$/.test(filename))));
  if (fs.existsSync(CHAT_ATTACHMENTS)) {
    for (const filename of fs.readdirSync(CHAT_ATTACHMENTS)) {
      if (/^[a-f0-9]{64}\.(?:jpg|png|webp|gif|mp4|webm|mp3|m4a|ogg|wav|pdf|txt|docx)$/.test(filename) && !referencedFiles.has(filename)) {
        fs.unlinkSync(path.join(CHAT_ATTACHMENTS, filename));
      }
    }
  }
  saveDatabase(database);
  return {removed,storage:chatStorageStatus(database)};
}

function messagesForUser(database, userId) {
  const visible = message => !(message.deleted_by || []).includes(userId);
  const group = database.messages.filter(item => item.to_user_id === 'group' && visible(item)).slice(-100);
  return group.sort((a, b) => Number(a.created) - Number(b.created));
}

function chatHistory(database, userId, query) {
  const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 50));
  const beforeId = query.get('before') || '';
  const keyword = (query.get('q') || '').trim().toLocaleLowerCase('pt-BR');
  const senderId = query.get('user') || '';
  const day = query.get('date') || '';
  const type = query.get('type') || '';
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ApiError(400, 'A data da pesquisa não é válida.');
  const filtered = database.messages.filter(message => {
    if (message.to_user_id !== 'group' || (message.deleted_by || []).includes(userId)) return false;
    if (senderId && message.from_user_id !== senderId) return false;
    if (day && new Date(Number(message.created)).toISOString().slice(0, 10) !== day) return false;
    if (type && !(message.attachments || []).some(attachment => attachment.type?.startsWith(`${type}/`))) return false;
    if (keyword && ![message.text, message.emoji, ...(message.attachments || []).map(item => item.name)]
      .join(' ').toLocaleLowerCase('pt-BR').includes(keyword)) return false;
    return true;
  }).sort((a,b) => Number(b.created)-Number(a.created));
  let start=0;
  if(beforeId) {
    const cursor=filtered.findIndex(message=>message.id===beforeId);
    if(cursor<0) throw new ApiError(400,'O marcador das mensagens anteriores não é válido.');
    start=cursor+1;
  }
  const page=filtered.slice(start,start+limit);
  return {messages:page.reverse(),has_more:filtered.length>start+limit};
}

function recordActivity(database, actorId, type, details = {}) {
  database.activity ||= [];
  database.activity.push({
    id: crypto.randomUUID(),
    type,
    actor_id: actorId,
    target_user_id: details.target_user_id || '',
    entity_type: details.entity_type || '',
    entity_id: details.entity_id || '',
    details: details.details || {},
    created: Date.now(),
  });
  if (database.activity.length > 10_000) database.activity.splice(0, database.activity.length - 10_000);
}

const notificationCategories = ['messages', 'watch', 'library', 'profiles', 'community'];
function notificationPreferences(user) {
  const stored = user.notification_preferences || {};
  const storedCategories = stored.categories || {};
  return {
    enabled:stored.enabled !== false,
    categories:Object.fromEntries(notificationCategories.map(category => [category, storedCategories[category] !== false])),
  };
}

function publicUser(user, includeNotificationPreferences = false) {
  const defaults = {
    avatar_frame:0,
    avatar_frame_color:'#a77bff',
    avatar_frame_element:'',
    avatar_frame_element_position:'bottom-right',
    avatar_frame_element_size:32,
    last_seen_at:0,
    chat_bubble_color:'#7253ad',
    chat_bubble_border:true,
    chat_bubble_border_color:'#a77bff',
  };
  const result = Object.fromEntries(['id', 'username', 'display_name', 'bio', 'avatar', 'role', ...Object.keys(defaults), 'created', 'last_login_at']
    .map(key => [key, user[key] ?? defaults[key] ?? (key === 'last_login_at' ? 0 : '')]));
  result.online = Date.now() - (presence.get(user.id) || 0) < 45_000;
  if (includeNotificationPreferences) {
    result.group_chat_muted = user.group_chat_muted === true;
    result.notification_preferences = notificationPreferences(user);
    result.activity_notifications_read_at = Number(user.activity_notifications_read_at) || 0;
    result.activity_notifications_cleared_at = Number(user.activity_notifications_cleared_at) || 0;
  }
  return result;
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
  if (typeof value === 'string' && /^\/media\/(?:perfis|capas|elementos)\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(value)) return value;
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
    if (size > MAX_BODY) throw new ApiError(400, 'A requisição está vazia ou excede o limite de 40 MB.');
    chunks.push(chunk);
  }
  if (!size) throw new ApiError(400, 'A requisição está vazia ou excede o limite de 40 MB.');
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

function sendMedia(request, response, pathname) {
  const chatMatch = pathname.match(/^\/media\/chat\/([a-f0-9]{64}\.(?:jpg|png|webp|gif|mp4|webm|mp3|m4a|ogg|wav|pdf|txt|docx))$/);
  if (chatMatch) {
    const filename = path.join(CHAT_ATTACHMENTS, chatMatch[1]);
    const database = loadDatabase();
    requireUser(request, database);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new ApiError(404, 'Arquivo não encontrado.');
    const extension = path.extname(filename).slice(1);
    const contentType = [...chatAttachmentTypes].find(([,type]) => type.extension === extension)?.[0];
    if (!contentType) throw new ApiError(404, 'Arquivo não encontrado.');
    const inline = chatAttachmentTypes.get(contentType).inline;
    const mediaPath = `/media/chat/${chatMatch[1]}`;
    const originalName = database.messages.flatMap(message => message.attachments || [])
      .find(attachment => attachment.url === mediaPath)?.name || `arquivo.${extension}`;
    const safeName = `${path.basename(originalName, path.extname(originalName)).replace(/[^\w.-]/g, '_') || 'arquivo'}.${extension}`;
    response.writeHead(200, {
      'Content-Type':contentType,
      'Content-Disposition':`${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
      'Cache-Control':'private, max-age=86400',
      'X-Content-Type-Options':'nosniff',
    });
    fs.createReadStream(filename).pipe(response);
    return;
  }
  const match = pathname.match(/^\/media\/(perfis|capas|elementos)\/([a-f0-9]{64}\.(?:jpg|png|webp))$/);
  if (!match) throw new ApiError(404, 'Imagem não encontrada.');
  const directory = match[1] === 'perfis' ? PROFILE_PHOTOS : match[1] === 'elementos' ? PROFILE_ELEMENTS : COVER_PHOTOS;
  const filename = path.join(directory, match[2]);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new ApiError(404, 'Imagem não encontrada.');
  requireUser(request, loadDatabase());
  const contentType = ({jpg:'image/jpeg',png:'image/png',webp:'image/webp'})[path.extname(filename).slice(1)];
  response.writeHead(200, {'Content-Type':contentType,'Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'});
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
  const requestedLabel = cleanText(value, 40);
  if (!['', 'Girls Love', 'Boys Love', 'Girls Lovers', 'Boys Lovers'].includes(requestedLabel)) throw new ApiError(400, 'Escolha uma categoria válida para o dorama.');
  const label = ({'Girls Lovers':'Girls Love','Boys Lovers':'Boys Love'})[requestedLabel] || requestedLabel;
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
  user.last_login_at = Date.now();
  user.last_seen_at = user.last_login_at;
  saveDatabase(database);
  presence.set(user.id, Date.now());
  sendJson(response, 200, { me: publicUser(user, true) }, createSession(user.id));
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
  const now = Date.now();
  const user = { id, username, display_name: displayName, bio: '', avatar: '', role:'member', password: passwordRecord(password), created: now, last_login_at: now, last_seen_at:now };
  database.users[id] = user;
  presence.set(id, Date.now());
  recordActivity(database, id, 'account_registered', { entity_type:'user', entity_id:id });
  saveDatabase(database);
  sendJson(response, 201, { me: publicUser(user, true) }, createSession(id));
}

function logout(request, response) {
  const database = loadDatabase();
  let changed = false;
  for (const part of (request.headers.cookie || '').split(';')) {
    if (!part.trim().startsWith('clube_session=')) continue;
    const token = part.trim().slice('clube_session='.length);
    const session = sessions.get(token);
    if (session) {
      presence.delete(session.userId);
      const user = database.users[session.userId];
      if (user) {
        user.last_seen_at = Date.now();
        changed = true;
      }
    }
    if (changed) saveDatabase(database);
    sessions.delete(token);
  }
  response.setHeader('Set-Cookie', 'clube_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  sendJson(response, 200, {});
}

function updatePresence(request, response, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  if (typeof payload.online !== 'boolean') throw new ApiError(400, 'Escolha um status válido.');
  const now = Date.now();
  let changed = false;
  if (payload.online) {
    presence.set(user.id, now);
    if (now - Number(user.last_seen_at || 0) >= 60_000) {
      user.last_seen_at = now;
      changed = true;
    }
  } else {
    presence.delete(user.id);
    user.last_seen_at = now;
    changed = true;
  }
  if (changed) saveDatabase(database);
  sendJson(response, 200, { online: payload.online });
}

function addEpisode(request, response, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const season = intValue(payload.season ?? 0, 'Temporada e episódio devem ser números.');
  const number = intValue(payload.episode_number ?? payload.episode ?? 0, 'Temporada e episódio devem ser números.');
  if (season < 1 || season > 999 || number < 1 || number > 9999) throw new ApiError(400, 'Informe uma temporada e um episódio válidos.');
  const series = cleanText(payload.series, 80, true);
  const key = normalize(series);
  const existingEpisodes = database.episodes.filter(item => normalize(item.series) === key);
  const requestedCover = storeImage(payload.cover, 'cover');
  const cover = requestedCover || existingEpisodes.find(item => item.cover)?.cover || '';
  if (requestedCover) existingEpisodes.forEach(item => { item.cover = requestedCover; });
  const episode = {
    id: crypto.randomUUID(), series, season, episode_number: number,
    title: cleanText(payload.title, 120, true), description: cleanText(payload.description ?? '', 2000),
    video_url: validateVideoUrl(payload.video_url), cover, added_by: user.id,
    created: Date.now(), progress: {}, comments: [],
  };
  database.episodes.unshift(episode);
  updateDisplayLabel(database, episode.series, payload.display_label);
  recordActivity(database, user.id, 'episode_added', {
    entity_type:'episode', entity_id:episode.id,
    details:{series:episode.series,title:episode.title,season:episode.season,episode_number:episode.episode_number},
  });
  saveDatabase(database);
  sendJson(response, 201, { episode });
}

function updateEpisode(request, response, id, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const episode = findEpisode(database, id);
  if (!episode) throw new ApiError(404, 'Esse episódio não existe.');
  const oldKey = normalize(episode.series);
  const series = cleanText(payload.series, 80, true);
  const season = intValue(payload.season ?? episode.season, 'Temporada e episódio devem ser números.');
  const number = intValue(payload.episode_number ?? payload.episode ?? episode.episode_number, 'Temporada e episódio devem ser números.');
  if (season < 1 || season > 999 || number < 1 || number > 9999) throw new ApiError(400, 'Informe uma temporada e um episódio válidos.');
  Object.assign(episode, { series, season, episode_number: number, title: cleanText(payload.title, 120, true),
    description: cleanText(payload.description ?? '', 2000), video_url: validateVideoUrl(payload.video_url) });
  if (Object.hasOwn(payload, 'cover')) {
    const requestedCover = storeImage(payload.cover, 'cover');
    if (requestedCover) {
      episode.cover = requestedCover;
      database.episodes.filter(item => item.id !== episode.id && normalize(item.series) === normalize(series))
        .forEach(item => { item.cover = requestedCover; });
    } else {
      episode.cover = database.episodes.find(item => item.id !== episode.id && normalize(item.series) === normalize(series) && item.cover)?.cover || '';
    }
  }
  const newKey = normalize(series);
  if (oldKey !== newKey && Object.hasOwn(database.series, oldKey)) { database.series[newKey] = database.series[oldKey]; delete database.series[oldKey]; }
  updateDisplayLabel(database, series, payload.display_label);
  recordActivity(database, user.id, 'episode_updated', {
    entity_type:'episode', entity_id:episode.id,
    details:{series:episode.series,title:episode.title,season:episode.season,episode_number:episode.episode_number},
  });
  saveDatabase(database);
  sendJson(response, 200, { episode });
}

function deleteEpisode(request, response, id) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const episode = findEpisode(database, id);
  if (!episode) throw new ApiError(404, 'Esse episódio não existe.');
  recordActivity(database, user.id, 'episode_deleted', {
    entity_type:'episode', entity_id:id,
    details:{series:episode.series,title:episode.title,season:episode.season,episode_number:episode.episode_number},
  });
  database.episodes = database.episodes.filter(item => item.id !== id);
  saveDatabase(database);
  sendJson(response, 200, { deleted: true });
}

function deleteSeries(request, response, name) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const key = normalize(name);
  if (!database.episodes.some(item => normalize(item.series) === key)) throw new ApiError(404, 'Esse dorama não existe.');
  recordActivity(database, user.id, 'series_deleted', {
    entity_type:'series', entity_id:key, details:{series:database.episodes.find(item => normalize(item.series) === key).series},
  });
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
  if (payload.status !== undefined && !['new', 'watching', 'done'].includes(payload.status)) throw new ApiError(400, 'Escolha um status válido para o episódio.');
  episode.progress ||= {};
  const mine = episode.progress[user.id] ||= {};
  if (payload.status !== undefined) {
    mine.status = payload.status;
    if (payload.status === 'done') {
      mine.is_watching = false;
      mine.last_watched = Date.now();
    } else if (payload.status === 'new') {
      mine.is_watching = false;
      delete mine.last_watched;
    }
    const seriesKey = normalize(episode.series);
    database.series[seriesKey] ||= {};
    const metadata = database.series[seriesKey];
    const seriesEpisodes = database.episodes.filter(item => normalize(item.series) === seriesKey);
    if (payload.status !== 'done' && metadata?.finished_by) delete metadata.finished_by[user.id];
    if (payload.status === 'done' && seriesEpisodes.every(item => item.progress?.[user.id]?.status === 'done')) {
      metadata.finished_by ||= {};
      metadata.finished_by[user.id] = Date.now();
    }
    recordActivity(database, user.id, 'episode_progress_updated', {
      entity_type:'episode', entity_id:id, details:{series:episode.series,title:episode.title,status:mine.status},
    });
  }
  if (payload.note !== undefined) mine.note = cleanText(payload.note, 120);
  if (payload.position_seconds !== undefined) {
    if (!Number.isInteger(payload.position_seconds) || payload.position_seconds < 0 || payload.position_seconds > 86_400) {
      throw new ApiError(400, 'Informe um minuto de parada válido.');
    }
    mine.last_position_seconds = payload.position_seconds;
  }
  saveDatabase(database);
  sendJson(response, 200, { progress: mine });
}

function recordEpisodeOpen(request, response, id) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const episode = findEpisode(database, id);
  if (!episode) throw new ApiError(404, 'Esse episódio não existe.');
  const now = Date.now();
  for (const otherEpisode of database.episodes) {
    const previous = otherEpisode.progress?.[user.id];
    if (previous?.is_watching) {
      previous.is_watching = false;
      previous.last_watched = now;
    }
  }
  episode.progress ||= {};
  const mine = episode.progress[user.id] ||= { status: 'new', note: '' };
  mine.status = mine.status === 'done' ? 'done' : 'watching';
  mine.is_watching = true;
  mine.watching_updated = now;
  mine.last_opened = now;
  recordActivity(database, user.id, 'episode_opened', {
    entity_type:'episode', entity_id:id, details:{series:episode.series,title:episode.title},
  });
  saveDatabase(database);
  sendJson(response, 200, { progress: mine });
}

function updateWatchingHeartbeat(request, response, id) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const episode = findEpisode(database, id);
  if (!episode) throw new ApiError(404, 'Esse episódio não existe.');
  episode.progress ||= {};
  const mine = episode.progress[user.id];
  if (!mine?.is_watching) throw new ApiError(409, 'Este episódio não está marcado como aberto.');
  mine.watching_updated = Date.now();
  saveDatabase(database);
  sendJson(response, 200, { progress:mine });
}

function stopWatchingEpisode(request, response, id, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const episode = findEpisode(database, id);
  if (!episode) throw new ApiError(404, 'Esse episódio não existe.');
  const mine = episode.progress?.[user.id];
  if (!mine) return sendJson(response, 200, { stopped:true });
  if (payload.position_seconds !== undefined
      && (!Number.isFinite(payload.position_seconds) || payload.position_seconds < 0 || payload.position_seconds > 86_400)) {
    throw new ApiError(400, 'Informe um minuto de parada válido.');
  }
  if (payload.position_seconds !== undefined) mine.last_position_seconds = Math.round(payload.position_seconds);
  mine.is_watching = false;
  mine.last_watched = Date.now();
  saveDatabase(database);
  sendJson(response, 200, { stopped:true, progress:mine });
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
  const text = cleanText(payload.text, 1000, true);
  episode.comments.push({ id: crypto.randomUUID(), user_id: user.id, text, mentions, created: Date.now() });
  recordActivity(database, user.id, 'episode_commented', {
    entity_type:'episode', entity_id:id, details:{series:episode.series,title:episode.title},
  });
  saveDatabase(database);
  sendJson(response, 201, { comments: episode.comments });
}

function updateEpisodeComment(request, response, episodeId, commentId, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const episode = findEpisode(database, episodeId);
  const comment = episode?.comments?.find(item => item.id === commentId);
  if (!episode || !comment || comment.user_id !== user.id) throw new ApiError(404, 'Este comentário não está disponível para edição.');
  if (Date.now() - Number(comment.created) > 120_000) throw new ApiError(403, 'O prazo de dois minutos para editar este comentário terminou.');
  const text = cleanText(payload.text, 1000, true);
  const requested = payload.mentions ?? [];
  if (!Array.isArray(requested) || requested.length > 20) throw new ApiError(400, 'A lista de marcações é inválida.');
  const allowed = new Set(Object.keys(database.users).filter(userId => userId !== user.id));
  Object.assign(comment, {
    text,
    mentions:[...new Set(requested.filter(value => typeof value === 'string' && allowed.has(value)))],
    edited:Date.now(),
  });
  recordActivity(database, user.id, 'episode_comment_edited', {
    entity_type:'episode', entity_id:episode.id,
    details:{series:episode.series,title:episode.title},
  });
  saveDatabase(database);
  sendJson(response, 200, { comments:episode.comments });
}

function deleteEpisodeComment(request, response, episodeId, commentId) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const episode = findEpisode(database, episodeId);
  const comment = episode?.comments?.find(item => item.id === commentId);
  if (!episode || !comment || comment.user_id !== user.id) throw new ApiError(404, 'Este comentário não está disponível para exclusão.');
  episode.comments = episode.comments.filter(item => item.id !== commentId);
  recordActivity(database, user.id, 'episode_comment_deleted', {
    entity_type:'episode', entity_id:episode.id,
    details:{series:episode.series,title:episode.title},
  });
  saveDatabase(database);
  sendJson(response, 200, { comments:episode.comments });
}

function updateSeriesComment(request, response, name, commentId, payload, deleting = false) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const key = normalize(name);
  const series = database.series[key];
  const comment = series?.comments?.find(item => item.id === commentId);
  if (!comment || comment.user_id !== user.id) throw new ApiError(404, 'Este comentário não está disponível.');
  if (!deleting && Date.now() - Number(comment.created) > 120_000) throw new ApiError(403, 'O prazo de dois minutos para editar este comentário terminou.');
  const title = database.episodes.find(item => normalize(item.series) === key)?.series || name;
  if (deleting) series.comments = series.comments.filter(item => item.id !== commentId);
  else Object.assign(comment, {text:cleanText(payload.text, 1000, true),edited:Date.now()});
  recordActivity(database, user.id, deleting ? 'series_comment_deleted' : 'series_comment_edited', {
    entity_type:'series', entity_id:key,
    details:{series:title},
  });
  saveDatabase(database);
  sendJson(response, 200, {series, comments:series.comments});
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
    const comment = { id: crypto.randomUUID(), user_id: user.id, text: cleanText(payload.text, 1000, true), created: Date.now() };
    drama.comments.push(comment);
    recordActivity(database, user.id, 'series_commented', {
      entity_type:'series', entity_id:key, details:{series:database.episodes.find(item => normalize(item.series) === key)?.series || name},
    });
  } else if (action === 'favorite') {
    if (typeof payload.favorite !== 'boolean') throw new ApiError(400, 'A escolha de favorito é inválida.');
    if (payload.favorite) drama.favorites[user.id] = true; else delete drama.favorites[user.id];
  } else if (action === 'progress') {
    if (typeof payload.finished !== 'boolean') throw new ApiError(400, 'Escolha se o dorama foi concluído.');
    drama.finished_by ||= {};
    const episodes = database.episodes.filter(item => normalize(item.series) === key);
    const now = Date.now();
    for (const item of episodes) {
      item.progress ||= {};
      const progress = item.progress[user.id] ||= {status:'new',note:''};
      progress.status = payload.finished ? 'done' : 'new';
      progress.is_watching = false;
      if (payload.finished) progress.last_watched = now;
      else {
        delete progress.last_watched;
      }
    }
    if (payload.finished) drama.finished_by[user.id] = now;
    else delete drama.finished_by[user.id];
  }
  if (action !== 'comments') recordActivity(database, user.id, 'series_updated', {
    entity_type:'series', entity_id:key,
    details:{series:database.episodes.find(item => normalize(item.series) === key)?.series, action, value:action === 'favorite' ? payload.favorite : action === 'progress' ? payload.finished : undefined},
  });
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
  const avatarFrame = payload.avatar_frame === undefined ? Number(user.avatar_frame || 0) : Number(payload.avatar_frame);
  if (!Number.isInteger(avatarFrame) || avatarFrame < 0 || avatarFrame > 10) throw new ApiError(400, 'Escolha uma moldura de perfil válida.');
  const avatarFrameColor = payload.avatar_frame_color === undefined ? (user.avatar_frame_color || '#a77bff') : payload.avatar_frame_color;
  if (typeof avatarFrameColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(avatarFrameColor)) throw new ApiError(400, 'Escolha uma cor válida para a moldura.');
  const avatarFrameElementPosition = payload.avatar_frame_element_position === undefined
    ? (user.avatar_frame_element_position || 'bottom-right') : payload.avatar_frame_element_position;
  const avatarPositions = ['top-left','top-center','top-right','middle-left','middle-right','bottom-left','bottom-center','bottom-right'];
  if (!avatarPositions.includes(avatarFrameElementPosition)) throw new ApiError(400, 'Escolha uma posição válida para o elemento da moldura.');
  const avatarFrameElementSize = payload.avatar_frame_element_size === undefined
    ? Number(user.avatar_frame_element_size || 32) : Number(payload.avatar_frame_element_size);
  if (!Number.isInteger(avatarFrameElementSize) || avatarFrameElementSize < 12 || avatarFrameElementSize > 80) throw new ApiError(400, 'O elemento deve ter entre 12 e 80 por cento do tamanho da moldura.');
  const avatarFrameElement = payload.avatar_frame_element === undefined ? (user.avatar_frame_element || '') : validateImage(payload.avatar_frame_element);
  const chatBubbleColor = payload.chat_bubble_color === undefined ? (user.chat_bubble_color || '#7253ad') : payload.chat_bubble_color;
  if (typeof chatBubbleColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(chatBubbleColor)) throw new ApiError(400, 'Escolha uma cor válida para seu balão de mensagem.');
  const chatBubbleBorder = payload.chat_bubble_border === undefined ? user.chat_bubble_border !== false : payload.chat_bubble_border;
  if (typeof chatBubbleBorder !== 'boolean') throw new ApiError(400, 'Escolha se deseja exibir a borda do balão.');
  const chatBubbleBorderColor = payload.chat_bubble_border_color === undefined ? (user.chat_bubble_border_color || '#a77bff') : payload.chat_bubble_border_color;
  if (typeof chatBubbleBorderColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(chatBubbleBorderColor)) throw new ApiError(400, 'Escolha uma cor válida para a borda do balão.');
  if (avatarFrameElement.startsWith('/media/') && !avatarFrameElement.startsWith('/media/elementos/')) {
    throw new ApiError(400, 'Escolha um arquivo próprio para o elemento decorativo.');
  }
  if (avatarFrameElement && avatarFrameElement.startsWith('data:image/') && !avatarFrameElement.startsWith('data:image/png;base64,')) {
    throw new ApiError(400, 'O elemento da moldura deve ser uma imagem PNG transparente.');
  }
  const changedFields = [];
  if (username !== user.username) changedFields.push('username');
  if (displayName !== user.display_name) changedFields.push('display_name');
  if (bio !== (user.bio || '')) changedFields.push('bio');
  if (avatar) changedFields.push('avatar');
  if (avatarFrame !== Number(user.avatar_frame || 0)) changedFields.push('avatar_frame');
  if (avatarFrameColor !== (user.avatar_frame_color || '#a77bff')) changedFields.push('avatar_frame_color');
  if (avatarFrameElement !== (user.avatar_frame_element || '')) changedFields.push('avatar_frame_element');
  if (avatarFrameElementPosition !== (user.avatar_frame_element_position || 'bottom-right')) changedFields.push('avatar_frame_element_position');
  if (avatarFrameElementSize !== Number(user.avatar_frame_element_size || 32)) changedFields.push('avatar_frame_element_size');
  if (chatBubbleColor.toLowerCase() !== (user.chat_bubble_color || '#7253ad').toLowerCase()) changedFields.push('chat_bubble_color');
  if (chatBubbleBorder !== (user.chat_bubble_border !== false)) changedFields.push('chat_bubble_border');
  if (chatBubbleBorderColor.toLowerCase() !== (user.chat_bubble_border_color || '#a77bff').toLowerCase()) changedFields.push('chat_bubble_border_color');
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
  if (avatar) user.avatar = storeImage(avatar, 'profile');
  user.avatar_frame = avatarFrame;
  user.avatar_frame_color = avatarFrameColor.toLowerCase();
  user.avatar_frame_element = avatarFrameElement ? storeImage(avatarFrameElement, 'element') : '';
  user.avatar_frame_element_position = avatarFrameElementPosition;
  user.avatar_frame_element_size = avatarFrameElementSize;
  user.chat_bubble_color = chatBubbleColor.toLowerCase();
  user.chat_bubble_border = chatBubbleBorder;
  user.chat_bubble_border_color = chatBubbleBorderColor.toLowerCase();
  if (changedFields.length) {
    recordActivity(database, user.id, 'profile_updated', {
      entity_type:'user', entity_id:user.id,
      details:{fields:changedFields},
    });
  }
  if (next) recordActivity(database, user.id, 'password_changed', {entity_type:'user',entity_id:user.id});
  saveDatabase(database);
  sendJson(response, 200, { me: publicUser(user, true) });
}

function updateChatPreferences(request, response, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  if (typeof payload.group_chat_muted !== 'boolean') throw new ApiError(400, 'Escolha se deseja silenciar o grupo.');
  user.group_chat_muted = payload.group_chat_muted;
  saveDatabase(database);
  sendJson(response, 200, {group_chat_muted:user.group_chat_muted});
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
  recordActivity(database, user.id, 'recommendation_sent', {
    target_user_id:payload.to_user_id, entity_type:'series', details:{series},
  });
  saveDatabase(database);
  sendJson(response, 201, { recommendation });
}

function handleMessage(request, response, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const recipientId = payload.to_user_id;
  if (recipientId !== 'group') throw new ApiError(400, 'As mensagens são enviadas apenas para o grupo geral.');
  const text = cleanText(payload.text ?? '', 2000);
  const emoji = cleanText(payload.emoji ?? '', 16);
  const requestedMentions = payload.mentions ?? [];
  if (!Array.isArray(requestedMentions) || requestedMentions.length > 20) throw new ApiError(400, 'A lista de marcações é inválida.');
  const allowed = new Set(Object.keys(database.users).filter(id => id !== user.id));
  const mentionedUsernames = new Set([...text.matchAll(/@([\w.-]+)/gu)].map(([, username]) => username.toLocaleLowerCase('pt-BR')));
  const mentions = [...new Set(requestedMentions.filter(id => typeof id === 'string' && allowed.has(id)
    && mentionedUsernames.has(database.users[id].username.toLocaleLowerCase('pt-BR'))))];
  const replyTo = typeof payload.reply_to_id === 'string'
    ? database.messages.find(item => item.id === payload.reply_to_id && item.to_user_id === 'group' && !(item.deleted_by || []).includes(user.id))
    : null;
  if (payload.reply_to_id && !replyTo) throw new ApiError(400, 'A mensagem original da resposta não está disponível.');
  const forwarded = typeof payload.forwarded_from_id === 'string'
    ? database.messages.find(item => item.id === payload.forwarded_from_id && item.to_user_id === 'group')
    : null;
  if (payload.forwarded_from_id && !forwarded) throw new ApiError(400, 'A mensagem encaminhada não está disponível.');
  requireChatStorage(database);
  const attachments = storeChatAttachments(payload.attachments);
  if (!text && !emoji && !attachments.length) throw new ApiError(400, 'Escreva uma mensagem ou selecione um arquivo.');
  const message = {
    id:crypto.randomUUID(),from_user_id:user.id,to_user_id:'group',text,emoji,mentions,attachments,
    bubble_color:user.chat_bubble_color || '#7253ad',
    bubble_border:user.chat_bubble_border !== false,
    bubble_border_color:user.chat_bubble_border_color || '#a77bff',
    reply_to_id:replyTo?.id || '',
    reply_preview:replyTo ? cleanText(replyTo.text || replyTo.attachments?.[0]?.name || replyTo.emoji || 'Anexo', 160) : '',
    forwarded_from_id:forwarded?.id || '',
    forwarded_from_name:forwarded ? cleanText(database.users[forwarded.from_user_id]?.display_name || 'Membro', 50) : '',
    reactions:[],
    read_by:[user.id],
    created:Date.now(),status:'sent',
  };
  database.messages.push(message);
  recordActivity(database, user.id, 'message_group_sent', {
    entity_type:'message', entity_id:message.id, details:{mentions},
  });
  if (database.messages.length > 1000) database.messages.splice(0, database.messages.length - 1000);
  saveDatabase(database);
  sendJson(response, 201, { message });
}

function updateMessage(request, response, id, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const message = database.messages.find(item => item.id === id);
  if (!message || message.to_user_id !== 'group' || message.from_user_id !== user.id || (message.deleted_by || []).includes(user.id)) {
    throw new ApiError(404, 'Esta mensagem não está disponível para edição.');
  }
  if (Date.now() - message.created > 60_000) throw new ApiError(403, 'O prazo de um minuto para editar esta mensagem terminou.');
  const text = cleanText(payload.text ?? '', 2000);
  const emoji = cleanText(payload.emoji ?? '', 16);
  if (!text && !emoji && !(message.attachments || []).length) throw new ApiError(400, 'Escreva uma mensagem ou escolha um emoji.');
  const requestedMentions = payload.mentions ?? [];
  if (!Array.isArray(requestedMentions) || requestedMentions.length > 20) throw new ApiError(400, 'A lista de marcações é inválida.');
  const usernames = new Set([...text.matchAll(/@([\w.-]+)/gu)].map(([,username]) => username.toLocaleLowerCase('pt-BR')));
  const mentions = [...new Set(requestedMentions.filter(userId => database.users[userId] && userId !== user.id
    && usernames.has(database.users[userId].username.toLocaleLowerCase('pt-BR'))))];
  Object.assign(message, {text,emoji,mentions,edited:Date.now()});
  recordActivity(database, user.id, 'message_edited', {
    target_user_id:message.to_user_id, entity_type:'message', entity_id:message.id,
  });
  saveDatabase(database);
  sendJson(response, 200, { message });
}

function chatMessageById(database, id) {
  const message = database.messages.find(item => item.id === id && item.to_user_id === 'group');
  if (!message) throw new ApiError(404, 'A mensagem não está mais disponível.');
  return message;
}

function updateChatRead(request, response) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const newest = database.messages.filter(message => message.to_user_id === 'group')
    .reduce((latest,message) => Math.max(latest,Number(message.created)||0),0);
  user.chat_read_at = Math.max(Number(user.chat_read_at)||0,newest);
  const readBy = new Set([user.id]);
  database.messages.filter(message => message.to_user_id === 'group' && Number(message.created) <= user.chat_read_at)
    .forEach(message => { message.read_by ||= []; if(!message.read_by.includes(user.id)) message.read_by.push(user.id); });
  saveDatabase(database);
  sendJson(response,200,{chat_read_at:user.chat_read_at});
}

function updateChatTyping(request, response, payload) {
  const database = loadDatabase();
  const user = requireUser(request,database);
  if (typeof payload.typing !== 'boolean') throw new ApiError(400,'O status de digitação é inválido.');
  if (payload.typing) chatTyping.set(user.id,{display_name:user.display_name,expires:Date.now()+4000});
  else chatTyping.delete(user.id);
  sendJson(response,200,{typing:payload.typing});
}

function updateChatReaction(request,response,id,payload) {
  const database=loadDatabase(), user=requireUser(request,database), message=chatMessageById(database,id);
  const emoji=cleanText(payload.emoji,8,true);
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Component})+$/u.test(emoji)) throw new ApiError(400,'Escolha uma reação de emoji válida.');
  message.reactions ||= [];
  const existing=message.reactions.find(reaction=>reaction.user_id===user.id&&reaction.emoji===emoji);
  if(existing) message.reactions=message.reactions.filter(reaction=>reaction!==existing);
  else message.reactions.push({user_id:user.id,emoji,created:Date.now()});
  saveDatabase(database);
  sendJson(response,200,{reactions:message.reactions});
}

function updateChatPin(request,response,id,payload) {
  const database=loadDatabase(), user=requireUser(request,database), message=chatMessageById(database,id);
  if (!['admin','moderator'].includes(user.role)) throw new ApiError(403,'Somente administradores e moderadores podem fixar mensagens.');
  if (typeof payload.pinned!=='boolean') throw new ApiError(400,'O estado da mensagem fixada é inválido.');
  message.pinned=payload.pinned;
  message.pinned_by=payload.pinned?user.id:'';
  message.pinned_at=payload.pinned?Date.now():0;
  saveDatabase(database);
  sendJson(response,200,{message});
}

function updateChatMemberRole(request,response,id,payload) {
  const database=loadDatabase(), user=requireUser(request,database), target=database.users[id];
  if(user.role!=='admin') throw new ApiError(403,'Somente um administrador pode alterar as permissões do grupo.');
  if(!target) throw new ApiError(404,'O participante não existe.');
  if(id===user.id) throw new ApiError(400,'Não é possível alterar sua própria permissão.');
  if(!['member','moderator','admin'].includes(payload.role)) throw new ApiError(400,'Escolha uma permissão válida.');
  target.role=payload.role;
  saveDatabase(database);
  sendJson(response,200,{user:publicUser(target)});
}

function forwardChatMessage(request,response,id,payload) {
  const database=loadDatabase(), user=requireUser(request,database), original=chatMessageById(database,id);
  const text=payload.text===undefined?(original.text||''):cleanText(payload.text,280);
  const message={
    id:crypto.randomUUID(),from_user_id:user.id,to_user_id:'group',text,emoji:original.emoji||'',
    mentions:[],attachments:original.attachments||[],bubble_color:user.chat_bubble_color||'#7253ad',
    bubble_border:user.chat_bubble_border!==false,bubble_border_color:user.chat_bubble_border_color||'#a77bff',
    forwarded_from_id:original.id,forwarded_from_name:cleanText(database.users[original.from_user_id]?.display_name||'Membro',50),
    reactions:[],read_by:[user.id],created:Date.now(),status:'sent',
  };
  requireChatStorage(database);
  database.messages.push(message);
  saveDatabase(database);
  sendJson(response,201,{message});
}

function chatUnreadCount(database,user) {
  return database.messages.filter(message=>message.to_user_id==='group'&&message.from_user_id!==user.id
    &&Number(message.created)>Number(user.chat_read_at||0)&&!(message.deleted_by||[]).includes(user.id)).length;
}

function deleteMessage(request, response, id) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const message = database.messages.find(item => item.id === id);
  if (!message || (message.to_user_id === 'group'
    ? message.from_user_id !== user.id && !['admin','moderator'].includes(user.role)
    : ![message.from_user_id, message.to_user_id].includes(user.id))) {
    throw new ApiError(404, 'Esta mensagem não está disponível para exclusão.');
  }
  const otherUserId = message.to_user_id === 'group' ? '' : message.from_user_id === user.id ? message.to_user_id : message.from_user_id;
  database.messages = database.messages.filter(item => item.id !== message.id);
  recordActivity(database, user.id, 'message_deleted', {
    target_user_id:otherUserId, entity_type:'message', entity_id:message.id,
    details:{sender_id:message.from_user_id,recipient_id:message.to_user_id},
  });
  saveDatabase(database);
  sendJson(response, 200, { deleted: true, for_everyone: true });
}

function activeWatchSession(database, id) {
  const session = database.watch_sessions.find(item => item.id === id && !item.ended);
  if (!session) throw new ApiError(404, 'Esta sessão de assistir juntos não está mais ativa.');
  return session;
}

function createWatchSession(request, response, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  requireChatStorage(database);
  if (typeof payload.episode_id !== 'string') throw new ApiError(400, 'Escolha um episódio para assistir.');
  const episode = findEpisode(database, payload.episode_id);
  if (!episode) throw new ApiError(404, 'Esse episódio não existe.');
  const isOpenGroupSession = payload.open === true;
  let recipients = [];
  if (payload.to_user_ids !== undefined) {
    if (!Array.isArray(payload.to_user_ids) || payload.to_user_ids.length > 10) {
      throw new ApiError(400, 'Convide no máximo dez pessoas.');
    }
    recipients = [...new Set(payload.to_user_ids)];
    if (recipients.some(id => typeof id !== 'string' || id === user.id || !database.users[id])) {
      throw new ApiError(400, 'A lista de convites contém um membro inválido.');
    }
  }
  if (!isOpenGroupSession && recipients.length === 0) throw new ApiError(400, 'Abra a solicitação para o grupo ou convide pelo menos uma pessoa.');
  const now = Date.now();
  const session = {
    id: crypto.randomUUID(),
    host_id: user.id,
    episode_id: episode.id,
    created: now,
    ended: false,
    open:isOpenGroupSession,
    ignored_by:[],
    participants: [user.id],
    invites: recipients.map(userId => ({ user_id: userId, status: 'pending', read: false, created: now })),
    playback: { position: 0, paused: true, updated: now, by: user.id },
  };
  database.watch_sessions.push(session);
  recordActivity(database, user.id, isOpenGroupSession ? 'watch_group_session_created' : 'watch_session_created', {
    entity_type:'watch_session', entity_id:session.id,
    details:{series:episode.series,title:episode.title,participants:[user.id]},
  });
  recipients.forEach(userId => recordActivity(database, user.id, 'watch_invite_sent', {
    target_user_id:userId, entity_type:'watch_session', entity_id:session.id,
    details:{series:episode.series,title:episode.title},
  }));
  database.watch_sessions = database.watch_sessions.filter(item => !item.ended || now - item.created < 24 * 60 * 60 * 1000);
  saveDatabase(database);
  sendJson(response, 201, { session });
}

function inviteToWatchSession(request, response, id, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  requireChatStorage(database);
  const session = activeWatchSession(database, id);
  if (!session.participants.includes(user.id)) throw new ApiError(403, 'Somente participantes podem enviar convites para esta sessão.');
  if (payload.to_user_ids !== undefined && (!Array.isArray(payload.to_user_ids) || payload.to_user_ids.length > 10)) {
    throw new ApiError(400, 'Escolha no máximo dez pessoas para convidar.');
  }
  const recipients = [...new Set(payload.to_user_ids || [])];
  if (recipients.some(userId => typeof userId !== 'string' || userId === user.id || !database.users[userId])) {
    throw new ApiError(400, 'A lista de convites contém um membro inválido.');
  }
  session.invites ||= [];
  const eligible = recipients.filter(userId => !session.participants.includes(userId)
    && !session.invites.some(invite => invite.user_id === userId && invite.status === 'pending'));
  if (!eligible.length && payload.open !== true) throw new ApiError(400, 'Todos os membros selecionados já participam ou têm um convite pendente.');
  if (payload.open === true) session.open = true;
  const now = Date.now();
  session.invites.push(...eligible.map(userId => ({ user_id: userId, from_user_id: user.id, status: 'pending', read: false, created: now })));
  const episode = findEpisode(database, session.episode_id);
  eligible.forEach(userId => recordActivity(database, user.id, 'watch_invite_sent', {
    target_user_id:userId, entity_type:'watch_session', entity_id:session.id,
    details:{series:episode?.series || '',title:episode?.title || ''},
  }));
  if (payload.open === true) recordActivity(database, user.id, 'watch_group_session_opened', {
    entity_type:'watch_session', entity_id:session.id,
    details:{series:episode?.series || '',title:episode?.title || ''},
  });
  saveDatabase(database);
  sendJson(response, 200, { session });
}

function respondToWatchInvite(request, response, id, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const session = activeWatchSession(database, id);
  if (session.open && ['join','ignore'].includes(payload.action)) {
    session.ignored_by ||= [];
    if (payload.action === 'ignore') {
      if (!session.participants.includes(user.id) && !session.ignored_by.includes(user.id)) session.ignored_by.push(user.id);
      saveDatabase(database);
      return sendJson(response, 200, {session,ignored:true});
    }
    session.ignored_by = session.ignored_by.filter(id => id !== user.id);
    if (!session.participants.includes(user.id)) {
      session.participants.push(user.id);
      const episode = findEpisode(database, session.episode_id);
      recordActivity(database, user.id, 'watch_session_joined', {
        entity_type:'watch_session', entity_id:session.id,
        details:{series:episode?.series || '',title:episode?.title || ''},
      });
    }
    saveDatabase(database);
    return sendJson(response, 200, {session,joined:true});
  }
  const invite = session.invites.find(item => item.user_id === user.id);
  if (!invite || invite.status !== 'pending') throw new ApiError(404, 'Este convite não está mais disponível.');
  if (!['accept', 'decline', 'ignore'].includes(payload.action)) throw new ApiError(400, 'Escolha entrar ou ignorar o convite.');
  const accepted = payload.action === 'accept';
  invite.status = accepted ? 'accepted' : 'declined';
  invite.read = true;
  invite.responded = Date.now();
  if (accepted && !session.participants.includes(user.id)) {
    session.participants.push(user.id);
    const episode = findEpisode(database, session.episode_id);
    recordActivity(database, user.id, 'watch_session_joined', {
      entity_type:'watch_session', entity_id:session.id,
      details:{series:episode?.series || '',title:episode?.title || ''},
    });
  } else if (!accepted) {
    recordActivity(database, user.id, 'watch_invite_declined', {
      entity_type:'watch_session', entity_id:session.id,
    });
  }
  saveDatabase(database);
  sendJson(response, 200, { session });
}

function leaveWatchSession(request, response, id) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const session = activeWatchSession(database, id);
  if (!session.participants.includes(user.id)) throw new ApiError(403, 'Você não participa desta sessão.');
  if (session.host_id === user.id) {
    session.ended = true;
    session.ended_at = Date.now();
    const episode = findEpisode(database, session.episode_id);
    recordActivity(database, user.id, 'watch_session_ended', {
      entity_type:'watch_session', entity_id:session.id,
      details:{series:episode?.series || '',title:episode?.title || '',participants:[...session.participants]},
    });
  } else {
    session.participants = session.participants.filter(userId => userId !== user.id);
    const episode = findEpisode(database, session.episode_id);
    recordActivity(database, user.id, 'watch_session_left', {
      entity_type:'watch_session', entity_id:session.id,
      details:{series:episode?.series || '',title:episode?.title || ''},
    });
  }
  saveDatabase(database);
  sendJson(response, 200, { ended: session.ended });
}

function updateWatchPlayback(request, response, id, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  const session = activeWatchSession(database, id);
  if (!session.participants.includes(user.id)) throw new ApiError(403, 'Você não participa desta sessão.');
  if (!Number.isFinite(payload.position) || payload.position < 0 || payload.position > 86_400 || typeof payload.paused !== 'boolean') {
    throw new ApiError(400, 'O estado de reprodução enviado é inválido.');
  }
  const previous = session.playback || {position:0,paused:true,updated:Date.now(),by:''};
  const now = Date.now();
  const expectedPreviousPosition = previous.position
    + (previous.paused ? 0 : Math.max(0, now - previous.updated) / 1000);
  if (previous.paused !== payload.paused || Math.abs(payload.position - expectedPreviousPosition) > 4) {
    const episode = findEpisode(database, session.episode_id);
    recordActivity(database, user.id, 'watch_playback_changed', {
      entity_type:'watch_session', entity_id:session.id,
      details:{
        series:episode?.series || '',title:episode?.title || '',
        paused:payload.paused,position:Math.floor(payload.position),
      },
    });
  }
  session.playback = { position: payload.position, paused: payload.paused, updated: now, by: user.id };
  saveDatabase(database);
  sendJson(response, 200, { playback: session.playback });
}

function markNotificationsRead(request, response) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  user.activity_notifications_read_at = Date.now();
  database.recommendations.forEach(item => { if (item.to_user_id === user.id) item.read = true; });
  database.messages.forEach(item => { if (item.to_user_id === user.id) item.read = true; });
  database.watch_sessions.forEach(session => {
    session.invites.forEach(invite => {
      if (invite.user_id === user.id && invite.status === 'pending') invite.read = true;
    });
  });
  saveDatabase(database);
  sendJson(response, 200, { read: true, me:publicUser(user, true) });
}

function clearNotifications(request, response) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  user.activity_notifications_cleared_at = Date.now();
  user.activity_notifications_read_at = user.activity_notifications_cleared_at;
  const dismiss = item => {
    item.dismissed_by ||= [];
    if (!item.dismissed_by.includes(user.id)) item.dismissed_by.push(user.id);
    item.read = true;
  };
  database.recommendations.forEach(item => { if (item.to_user_id === user.id) dismiss(item); });
  database.messages.forEach(item => {
    if (item.to_user_id === user.id || item.from_user_id === user.id) dismiss(item);
  });
  database.watch_sessions.forEach(session => {
    session.invites.forEach(invite => { if (invite.user_id === user.id) dismiss(invite); });
  });
  saveDatabase(database);
  sendJson(response, 200, { cleared: true });
}

function updateNotificationPreferences(request, response, payload) {
  const database = loadDatabase();
  const user = requireUser(request, database);
  if (typeof payload.enabled !== 'boolean' || !payload.categories || typeof payload.categories !== 'object' || Array.isArray(payload.categories)) {
    throw new ApiError(400, 'As preferências de notificações são inválidas.');
  }
  if (notificationCategories.some(category => typeof payload.categories[category] !== 'boolean')) {
    throw new ApiError(400, 'Escolha se deseja receber cada tipo de notificação.');
  }
  user.notification_preferences = {
    enabled:payload.enabled,
    categories:Object.fromEntries(notificationCategories.map(category => [category, payload.categories[category]])),
  };
  saveDatabase(database);
  sendJson(response, 200, {notification_preferences:notificationPreferences(user)});
}

async function handle(request, response) {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html') return sendFile(response, 'index.html', 'text/html; charset=utf-8');
      if (pathname === '/style.css') return sendFile(response, 'style.css', 'text/css; charset=utf-8');
      if (pathname === '/IMAGENS/logo.png') return sendFile(response, 'IMAGENS/logo.png', 'image/png');
      if (pathname.startsWith('/media/')) return sendMedia(request, response, pathname);
      if (pathname === '/api/me') {
        const database = loadDatabase(); const user = sessionUser(request, database);
        return sendJson(response, 200, { me: user ? publicUser(user, true) : null });
      }
      if (pathname === '/api/live') {
        const database = loadDatabase(); const user = requireUser(request, database);
        const messages = messagesForUser(database, user.id);
        const recommendations = database.recommendations;
        const watch_sessions = database.watch_sessions.filter(item => !item.ended);
        const now=Date.now();
        for(const [userId,typing] of chatTyping) if(typing.expires<=now) chatTyping.delete(userId);
        const typing_users=[...chatTyping.entries()].filter(([userId])=>userId!==user.id).map(([userId,typing])=>({id:userId,display_name:typing.display_name}));
        const deliveredMessages=messages.map(message=>({...message,delivered_to:[...new Set([...(message.delivered_to||[]),...(message.from_user_id!==user.id?[user.id]:[])])]}));
        return sendJson(response, 200, { messages:deliveredMessages, recommendations, watch_sessions, activity:database.activity.slice(-100), chat_storage:chatStorageStatus(database), chat_unread_count:chatUnreadCount(database,user),typing_users });
      }
      if (pathname === '/api/chat/messages') {
        const database=loadDatabase(), user=requireUser(request,database), url=new URL(request.url,'http://127.0.0.1');
        return sendJson(response,200,chatHistory(database,user.id,url.searchParams));
      }
      const chatMessageMatch=pathname.match(/^\/api\/chat\/messages\/([a-f0-9-]+)$/);
      if(chatMessageMatch) {
        const database=loadDatabase(),user=requireUser(request,database);
        return sendJson(response,200,{message:chatMessageById(database,chatMessageMatch[1])});
      }
      if (pathname === '/api/activity') {
        const database = loadDatabase();
        requireUser(request, database);
        const url = new URL(request.url, 'http://127.0.0.1');
        const limitValue = Number(url.searchParams.get('limit') || 100);
        const limit = Number.isInteger(limitValue) ? Math.min(100, Math.max(1, limitValue)) : 100;
        const beforeId = url.searchParams.get('before');
        const end = beforeId ? database.activity.findIndex(item => item.id === beforeId) : database.activity.length;
        if (beforeId && end < 0) throw new ApiError(400, 'O marcador da linha do tempo não é válido.');
        const endIndex = beforeId ? end : database.activity.length;
        const startIndex = Math.max(0, endIndex - limit);
        return sendJson(response, 200, {
          events:database.activity.slice(startIndex, endIndex),
          has_more:startIndex > 0,
        });
      }
      if (pathname === '/api/data') {
        const database = loadDatabase(); const user = requireUser(request, database);
        const users = Object.values(database.users).map(item => ({ ...publicUser(item), online: Date.now() - (presence.get(item.id) || 0) < 45_000 }));
        const messages = messagesForUser(database, user.id);
        const deliveredMessages=messages.map(message=>({...message,delivered_to:[...new Set([...(message.delivered_to||[]),...(message.from_user_id!==user.id?[user.id]:[])])]}));
        const watch_sessions = database.watch_sessions.filter(item => !item.ended);
        return sendJson(response, 200, {
          me:{...publicUser(user, true),online:true},users,episodes:database.episodes,series:database.series,
          recommendations:database.recommendations,messages:deliveredMessages,watch_sessions,
          activity:database.activity.slice(-100),activity_has_more:database.activity.length > 100,
          chat_storage:chatStorageStatus(database),chat_unread_count:chatUnreadCount(database,user),
          chat_history_has_more:database.messages.filter(message=>message.to_user_id==='group'&&!(message.deleted_by||[]).includes(user.id)).length>messages.length,
        });
      }
      return sendJson(response, 404, { error: 'Página não encontrada.' });
    }
    if (!['POST', 'PUT', 'DELETE'].includes(request.method)) return sendJson(response, 405, { error: 'Método não permitido.' });
    const payload = request.method === 'DELETE' ? {} : await readJson(request);
    if (request.method === 'POST') {
      if (pathname === '/api/login') return login(request, response, payload);
      if (pathname === '/api/register') return register(request, response, payload);
      if (pathname === '/api/logout') return logout(request, response);
      if (pathname === '/api/presence') return updatePresence(request, response, payload);
      if (pathname === '/api/episodes') return addEpisode(request, response, payload);
      if (pathname === '/api/profile') return updateProfile(request, response, payload);
      if (pathname === '/api/chat/preferences') return updateChatPreferences(request, response, payload);
      if (pathname === '/api/chat/read') return updateChatRead(request,response);
      if (pathname === '/api/chat/typing') return updateChatTyping(request,response,payload);
      if (pathname === '/api/messages') return handleMessage(request, response, payload);
      let chatMatch=pathname.match(/^\/api\/chat\/messages\/([a-f0-9-]+)\/(reactions|pin|forward)$/);
      if(chatMatch) {
        if(chatMatch[2]==='reactions') return updateChatReaction(request,response,chatMatch[1],payload);
        if(chatMatch[2]==='pin') return updateChatPin(request,response,chatMatch[1],payload);
        return forwardChatMessage(request,response,chatMatch[1],payload);
      }
      chatMatch=pathname.match(/^\/api\/chat\/members\/([a-f0-9-]+)\/role$/);
      if(chatMatch) return updateChatMemberRole(request,response,chatMatch[1],payload);
      if (pathname === '/api/chat/cleanup') {
        const database = loadDatabase();
        requireUser(request, database);
        return sendJson(response, 200, cleanupChatStorage(database));
      }
      if (pathname === '/api/notifications/read') return markNotificationsRead(request, response);
      if (pathname === '/api/notifications/clear') return clearNotifications(request, response);
      if (pathname === '/api/notifications/preferences') return updateNotificationPreferences(request, response, payload);
      if (pathname === '/api/watch-together') return createWatchSession(request, response, payload);
      let match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)\/progress$/);
      if (match) return updateProgress(request, response, match[1], payload);
      match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)\/open$/);
      if (match) return recordEpisodeOpen(request, response, match[1]);
      match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)\/heartbeat$/);
      if (match) return updateWatchingHeartbeat(request, response, match[1]);
      match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)\/stop$/);
      if (match) return stopWatchingEpisode(request, response, match[1], payload);
      match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)\/comments$/);
      if (match) return addComment(request, response, match[1], payload);
      match = pathname.match(/^\/api\/series\/([^/]+)\/comments$/);
      if (match) return updateSeries(request, response, decodePath(match[1]), 'comments', payload);
      match = pathname.match(/^\/api\/watch-together\/([a-f0-9-]+)\/(invite|respond|playback|leave)$/);
      if (match) {
        if (match[2] === 'invite') return inviteToWatchSession(request, response, match[1], payload);
        if (match[2] === 'respond') return respondToWatchInvite(request, response, match[1], payload);
        if (match[2] === 'playback') return updateWatchPlayback(request, response, match[1], payload);
        return leaveWatchSession(request, response, match[1]);
      }
      match = pathname.match(/^\/api\/series\/([^/]+)\/(preferences|comments|background|favorite|progress)$/);
      if (match) return updateSeries(request, response, decodePath(match[1]), match[2], payload);
      if (pathname === '/api/recommendations') return handleRecommendation(request, response, payload);
    } else if (request.method === 'PUT') {
      if (pathname === '/api/presence') return updatePresence(request, response, payload);
      const messageMatch = pathname.match(/^\/api\/messages\/([a-f0-9-]+)$/);
      if (messageMatch) return updateMessage(request, response, messageMatch[1], payload);
      let match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)$/);
      if (match) return updateEpisode(request, response, match[1], payload);
      match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)\/comments\/([a-f0-9-]+)$/);
      if (match) return updateEpisodeComment(request, response, match[1], match[2], payload);
      match = pathname.match(/^\/api\/series\/([^/]+)\/comments\/([a-f0-9-]+)$/);
      if (match) return updateSeriesComment(request, response, decodePath(match[1]), match[2], payload);
    } else {
      if (pathname === '/api/chat/messages') {
        const database = loadDatabase();
        requireUser(request, database);
        return sendJson(response, 200, cleanupChatStorage(database));
      }
      const messageMatch = pathname.match(/^\/api\/messages\/([a-f0-9-]+)$/);
      if (messageMatch) return deleteMessage(request, response, messageMatch[1]);
      let match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)$/);
      if (match) return deleteEpisode(request, response, match[1]);
      match = pathname.match(/^\/api\/episodes\/([a-f0-9-]+)\/comments\/([a-f0-9-]+)$/);
      if (match) return deleteEpisodeComment(request, response, match[1], match[2]);
      match = pathname.match(/^\/api\/series\/([^/]+)\/comments\/([a-f0-9-]+)$/);
      if (match) return updateSeriesComment(request, response, decodePath(match[1]), match[2], {}, true);
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

fs.mkdirSync(PROFILE_ELEMENTS, { recursive: true });
loadDatabase();
const server = http.createServer(handle);
const port = Number(process.env.PORT || 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A variável PORT deve ser uma porta entre 1 e 65535.');
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`P'Clube disponível em http://localhost:${port}`);
  if (host === '0.0.0.0' || host === '::') {
    const addresses = Object.values(os.networkInterfaces()).flatMap(interfaces => interfaces || [])
      .filter(address => address.family === 'IPv4' && !address.internal)
      .map(address => address.address);
    addresses.forEach(address => console.log(`Acesso pela rede local: http://${address}:${port}`));
  }
  console.log('Para sair, pressione Ctrl+C.');
});