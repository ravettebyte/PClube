"""Local development server for Clube do Episódio."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
import time
import uuid
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "usuarios.json"
MAX_BODY = 5 * 1024 * 1024
MAX_IMAGE_BYTES = 3 * 1024 * 1024
PASSWORD_ITERATIONS = 310_000
SESSION_TTL = 60 * 60 * 24 * 14
DB_LOCK = threading.RLock()
SESSIONS: dict[str, tuple[str, float]] = {}
SEED_ACCOUNTS = [
    ("membro01", "Membro 01", "RoxoClube#01"),
    ("membro02", "Membro 02", "RoxoClube#02"),
    ("membro03", "Membro 03", "RoxoClube#03"),
    ("membro04", "Membro 04", "RoxoClube#04"),
    ("membro05", "Membro 05", "RoxoClube#05"),
    ("membro06", "Membro 06", "RoxoClube#06"),
    ("membro07", "Membro 07", "RoxoClube#07"),
    ("membro08", "Membro 08", "RoxoClube#08"),
    ("membro09", "Membro 09", "RoxoClube#09"),
    ("membro10", "Membro 10", "RoxoClube#10"),
]
VIDEO_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".ogg"}
IMAGE_PREFIXES = (
    "data:image/jpeg;base64,",
    "data:image/png;base64,",
    "data:image/webp;base64,",
)
DRAMA_GENRES = {
    "Ação",
    "Aventura",
    "Comédia",
    "Crime",
    "Drama",
    "Fantasia",
    "Histórico",
    "Mistério",
    "Romance",
    "Suspense",
    "Terror",
    "Vida escolar",
    "Ficção científica",
}


def password_record(password: str, salt: bytes | None = None) -> dict[str, str]:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
    )
    return {"salt": salt.hex(), "hash": digest.hex()}


def password_matches(password: str, record: dict[str, str]) -> bool:
    try:
        candidate = password_record(password, bytes.fromhex(record["salt"]))["hash"]
    except (KeyError, ValueError):
        return False
    return hmac.compare_digest(candidate, record.get("hash", ""))


def empty_database() -> dict[str, object]:
    return {"users": {}, "episodes": [], "series": {}, "recommendations": []}


def load_database() -> dict[str, object]:
    with DB_LOCK:
        if not DATABASE.exists() or not DATABASE.read_text(encoding="utf-8").strip():
            data = empty_database()
        else:
            data = json.loads(DATABASE.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("users"), dict) or not isinstance(data.get("episodes"), list):
            raise ValueError(f"Formato inválido no arquivo {DATABASE.name}.")
        if "series" not in data:
            data["series"] = {}
        if not isinstance(data["series"], dict):
            raise ValueError(f"Formato inválido no catálogo de doramas em {DATABASE.name}.")
        if "recommendations" not in data:
            data["recommendations"] = []
        if not isinstance(data["recommendations"], list):
            raise ValueError(f"Formato inválido para recomendações em {DATABASE.name}.")
        if not data["users"]:
            users = {}
            for username, display_name, password in SEED_ACCOUNTS:
                user_id = str(uuid.uuid4())
                users[user_id] = {
                    "id": user_id,
                    "username": username,
                    "display_name": display_name,
                    "bio": "",
                    "avatar": "",
                    "password": password_record(password),
                    "created": int(time.time() * 1000),
                }
            data["users"] = users
            save_database(data)
        return data


def save_database(data: dict[str, object]) -> None:
    with DB_LOCK:
        temporary_name = ""
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=ROOT,
                prefix=".usuarios-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_name = temporary.name
                json.dump(data, temporary, ensure_ascii=False, indent=2)
                temporary.write("\n")
            os.replace(temporary_name, DATABASE)
        finally:
            if temporary_name and os.path.exists(temporary_name):
                os.unlink(temporary_name)


def public_user(user: dict[str, object]) -> dict[str, object]:
    return {
        key: user.get(key, "")
        for key in ("id", "username", "display_name", "bio", "avatar", "created")
    }


def clean_text(value: object, maximum: int, required: bool = False) -> str:
    if not isinstance(value, str):
        raise ValueError("Revise os campos de texto enviados.")
    result = value.strip()
    if required and not result:
        raise ValueError("Preencha todos os campos obrigatórios.")
    if len(result) > maximum:
        raise ValueError(f"O texto deve ter no máximo {maximum} caracteres.")
    return result


def validate_image(value: object) -> str:
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or not value.startswith(IMAGE_PREFIXES):
        raise ValueError("A imagem deve ser JPG, PNG ou WebP.")
    try:
        encoded = value.split(",", 1)[1]
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("A imagem enviada é inválida.") from error
    if len(decoded) > MAX_IMAGE_BYTES:
        raise ValueError("A imagem pode ter no máximo 3 MB.")
    return value


def validate_video_url(value: object) -> str:
    url = clean_text(value, 500, required=True)
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Use um link HTTPS do YouTube ou de um vídeo direto.")
    hostname = parsed.hostname.lower()
    if hostname in VIDEO_HOSTS:
        video_id = ""
        if hostname == "youtu.be":
            video_id = parsed.path.strip("/").split("/", 1)[0]
        else:
            video_id = parse_qs(parsed.query).get("v", [""])[0]
            if not video_id:
                match = re.match(r"^/(?:embed|shorts|live|v)/([\w-]{11})(?:/|$)", parsed.path)
                if match:
                    video_id = match.group(1)
        if not re.fullmatch(r"[\w-]{11}", video_id):
            raise ValueError("Use um link direto de vídeo do YouTube, Shorts ou transmissão.")
        return url
    if Path(parsed.path).suffix.lower() not in VIDEO_EXTENSIONS:
        raise ValueError("O link direto deve apontar para um arquivo .mp4, .webm ou .ogg.")
    return url


def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = (user_id, time.time() + SESSION_TTL)
    return token


class AppHandler(BaseHTTPRequestHandler):
    server_version = "ClubeDoEpisodio/1.0"

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def send_json(
        self,
        data: dict[str, object],
        status: HTTPStatus = HTTPStatus.OK,
        session_token: str | None = None,
    ) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if session_token:
            self.send_header(
                "Set-Cookie",
                f"clube_session={session_token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}",
            )
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, object]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Tamanho da requisição inválido.") from error
        if length <= 0 or length > MAX_BODY:
            raise ValueError("A requisição está vazia ou excede o limite de 5 MB.")
        if self.headers.get_content_type() != "application/json":
            raise ValueError("O servidor espera dados no formato JSON.")
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("Não foi possível interpretar os dados enviados.") from error
        if not isinstance(payload, dict):
            raise ValueError("O corpo da requisição deve ser um objeto JSON.")
        return payload

    def session_user(self, database: dict[str, object]) -> dict[str, object] | None:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("clube_session")
        if not morsel:
            return None
        session = SESSIONS.get(morsel.value)
        if not session:
            return None
        user_id, expires = session
        if expires < time.time():
            SESSIONS.pop(morsel.value, None)
            return None
        return database["users"].get(user_id)

    def require_user(self, database: dict[str, object]) -> dict[str, object]:
        user = self.session_user(database)
        if user is None:
            raise PermissionError("Entre na sua conta para continuar.")
        return user

    def do_GET(self) -> None:
        try:
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                self.serve_file("index.html", "text/html; charset=utf-8")
                return
            if path == "/style.css":
                self.serve_file("style.css", "text/css; charset=utf-8")
                return
            if path == "/IMAGENS/logo.png":
                self.serve_file("IMAGENS/logo.png", "image/png")
                return
            if path == "/api/me":
                database = load_database()
                user = self.session_user(database)
                self.send_json({"me": public_user(user) if user else None})
                return
            if path == "/api/data":
                database = load_database()
                user = self.require_user(database)
                self.send_json(
                    {
                        "me": public_user(user),
                        "users": [public_user(item) for item in database["users"].values()],
                        "episodes": database["episodes"],
                        "series": database["series"],
                        "recommendations": database.get("recommendations", []),
                    }
                )
                return
            self.send_json({"error": "Página não encontrada."}, HTTPStatus.NOT_FOUND)
        except PermissionError as error:
            self.send_json({"error": str(error)}, HTTPStatus.UNAUTHORIZED)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            self.send_json({"error": f"Não foi possível ler os dados: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            if path == "/api/login":
                self.login(payload)
            elif path == "/api/register":
                self.register(payload)
            elif path == "/api/logout":
                self.logout()
            elif path == "/api/episodes":
                self.add_episode(payload)
            elif path == "/api/profile":
                self.update_profile(payload)
            elif match := re.fullmatch(r"/api/episodes/([a-f0-9-]+)/progress", path):
                self.update_progress(match.group(1), payload)
            elif match := re.fullmatch(r"/api/episodes/([a-f0-9-]+)/open", path):
                self.record_episode_open(match.group(1))
            elif match := re.fullmatch(r"/api/episodes/([a-f0-9-]+)/comments", path):
                self.add_comment(match.group(1), payload)
            elif match := re.fullmatch(r"/api/series/([^/]+)/(preferences|comments|background|favorite)", path):
                self.update_series(unquote(match.group(1)), match.group(2), payload)
            elif path == "/api/recommendations":
                self.handle_recommendation(payload)
            else:
                self.send_json({"error": "Ação não encontrada."}, HTTPStatus.NOT_FOUND)
        except PermissionError as error:
            self.send_json({"error": str(error)}, HTTPStatus.UNAUTHORIZED)
        except ValueError as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except (OSError, json.JSONDecodeError) as error:
            self.send_json({"error": f"Não foi possível salvar os dados: {error}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def serve_file(self, name: str, content_type: str) -> None:
        file_path = ROOT / name
        content = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def login(self, payload: dict[str, object]) -> None:
        username = clean_text(payload.get("username"), 24, required=True).lower()
        password = clean_text(payload.get("password"), 256, required=True)
        database = load_database()
        user = next(
            (item for item in database["users"].values() if item["username"] == username),
            None,
        )
        if user is None or not password_matches(password, user["password"]):
            self.send_json({"error": "Usuário ou senha incorretos."}, HTTPStatus.UNAUTHORIZED)
            return
        self.send_json({"me": public_user(user)}, session_token=create_session(user["id"]))

    def register(self, payload: dict[str, object]) -> None:
        display_name = clean_text(payload.get("display_name"), 50, required=True)
        username = clean_text(payload.get("username"), 24, required=True).lower()
        password = clean_text(payload.get("password"), 256, required=True)
        if not re.fullmatch(r"[a-z0-9_.-]{3,24}", username):
            raise ValueError("O usuário deve ter 3–24 caracteres: letras, números, ponto, hífen ou sublinhado.")
        if len(password) < 10:
            raise ValueError("A senha deve ter pelo menos 10 caracteres.")
        database = load_database()
        if any(item["username"] == username for item in database["users"].values()):
            raise ValueError("Esse nome de usuário já está em uso.")
        user_id = str(uuid.uuid4())
        user = {
            "id": user_id,
            "username": username,
            "display_name": display_name,
            "bio": "",
            "avatar": "",
            "password": password_record(password),
            "created": int(time.time() * 1000),
        }
        database["users"][user_id] = user
        save_database(database)
        self.send_json(
            {"me": public_user(user)},
            HTTPStatus.CREATED,
            session_token=create_session(user_id),
        )

    def logout(self) -> None:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("clube_session")
        if morsel:
            SESSIONS.pop(morsel.value, None)
        self.send_response(HTTPStatus.OK)
        self.send_header("Set-Cookie", "clube_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def add_episode(self, payload: dict[str, object]) -> None:
        database = load_database()
        user = self.require_user(database)
        series = clean_text(payload.get("series"), 80, required=True)
        title = clean_text(payload.get("title"), 120, required=True)
        description = clean_text(payload.get("description", ""), 2000)
        video_url = validate_video_url(payload.get("video_url"))
        try:
            season = int(payload.get("season", 0))
            episode_number = int(payload.get("episode_number", 0))
        except (ValueError, TypeError) as error:
            raise ValueError("Temporada e episódio devem ser números.") from error
        if not (1 <= season <= 999 and 1 <= episode_number <= 9999):
            raise ValueError("Informe uma temporada e um episódio válidos.")
        episode_id = str(uuid.uuid4())
        episode = {
            "id": episode_id,
            "series": series,
            "season": season,
            "episode_number": episode_number,
            "title": title,
            "description": description,
            "video_url": video_url,
            "cover": validate_image(payload.get("cover")),
            "added_by": user["id"],
            "created": int(time.time() * 1000),
            "progress": {},
            "comments": [],
        }
        database["episodes"].insert(0, episode)
        save_database(database)
        self.send_json({"episode": episode}, HTTPStatus.CREATED)

    def update_progress(self, episode_id: str, payload: dict[str, object]) -> None:
        database = load_database()
        user = self.require_user(database)
        episode = next((item for item in database["episodes"] if item["id"] == episode_id), None)
        if episode is None:
            self.send_json({"error": "Esse episódio não existe."}, HTTPStatus.NOT_FOUND)
            return
        status = payload.get("status")
        if status not in ("new", "watching", "done"):
            raise ValueError("Escolha um status válido para o episódio.")
        note = clean_text(payload.get("note", ""), 120)
        progress = episode["progress"].setdefault(user["id"], {})
        progress.update({"status": status, "note": note})
        save_database(database)
        self.send_json({"progress": progress})

    def record_episode_open(self, episode_id: str) -> None:
        database = load_database()
        user = self.require_user(database)
        episode = next((item for item in database["episodes"] if item["id"] == episode_id), None)
        if episode is None:
            self.send_json({"error": "Esse episódio não existe."}, HTTPStatus.NOT_FOUND)
            return
        progress = episode["progress"].setdefault(user["id"], {"status": "new", "note": ""})
        progress["last_opened"] = int(time.time() * 1000)
        save_database(database)
        self.send_json({"progress": progress})

    def add_comment(self, episode_id: str, payload: dict[str, object]) -> None:
        database = load_database()
        user = self.require_user(database)
        episode = next((item for item in database["episodes"] if item["id"] == episode_id), None)
        if episode is None:
            self.send_json({"error": "Esse episódio não existe."}, HTTPStatus.NOT_FOUND)
            return
        text = clean_text(payload.get("text"), 1000, required=True)
        requested_mentions = payload.get("mentions", [])
        if not isinstance(requested_mentions, list) or len(requested_mentions) > 20:
            raise ValueError("A lista de marcações é inválida.")
        known_ids = set(database["users"]) - {user["id"]}
        mentions = list(dict.fromkeys(item for item in requested_mentions if item in known_ids))
        comment = {
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "text": text,
            "mentions": mentions,
            "created": int(time.time() * 1000),
        }
        episode["comments"].append(comment)
        save_database(database)
        self.send_json({"comments": episode["comments"]}, HTTPStatus.CREATED)

    def update_series(self, series_name: str, action: str, payload: dict[str, object]) -> None:
        database = load_database()
        user = self.require_user(database)
        normalized_name = series_name.strip().lower()
        episodes = database["episodes"]
        if not any(
            item["series"].strip().lower() == normalized_name
            for item in episodes
            if isinstance(item.get("series"), str)
        ):
            self.send_json({"error": "Esse dorama não existe."}, HTTPStatus.NOT_FOUND)
            return

        series_catalog = database["series"]
        drama = series_catalog.setdefault(
            normalized_name,
            {"background_url": "", "genres": {}, "ratings": {}, "comments": [], "favorites": {}},
        )
        if not isinstance(drama, dict):
            raise ValueError("Os dados de classificação deste dorama estão inválidos.")
        genres_by_user = drama.setdefault("genres", {})
        ratings_by_user = drama.setdefault("ratings", {})
        comments = drama.setdefault("comments", [])
        favorites_by_user = drama.setdefault("favorites", {})
        if not isinstance(genres_by_user, dict) or not isinstance(ratings_by_user, dict) or not isinstance(comments, list) or not isinstance(favorites_by_user, dict):
            raise ValueError("Os dados de classificação deste dorama estão inválidos.")

        if action == "preferences":
            if "genres" in payload:
                genres = payload["genres"]
                if not isinstance(genres, list) or len(genres) > 3:
                    raise ValueError("Escolha no máximo três gêneros.")
                if any(not isinstance(genre, str) or genre not in DRAMA_GENRES for genre in genres):
                    raise ValueError("Escolha gêneros válidos para o dorama.")
                genres_by_user[user["id"]] = list(dict.fromkeys(genres))

            if "rating" in payload:
                rating = payload["rating"]
                if rating is None:
                    ratings_by_user.pop(user["id"], None)
                elif isinstance(rating, bool) or not isinstance(rating, int) or not 1 <= rating <= 5:
                    raise ValueError("A nota deve ser de uma a cinco estrelas.")
                else:
                    ratings_by_user[user["id"]] = rating
        elif action == "background":
            background_url = clean_text(payload.get("background_url", ""), 500)
            drama["background_url"] = validate_video_url(background_url) if background_url else ""
        elif action == "comments":
            text = clean_text(payload.get("text"), 1000, required=True)
            comments.append(
                {
                    "id": str(uuid.uuid4()),
                    "user_id": user["id"],
                    "text": text,
                    "created": int(time.time() * 1000),
                }
            )
        elif action == "favorite":
            favorite = payload.get("favorite")
            if not isinstance(favorite, bool):
                raise ValueError("A escolha de favorito é inválida.")
            if favorite:
                favorites_by_user[user["id"]] = True
            else:
                favorites_by_user.pop(user["id"], None)
        save_database(database)
        self.send_json({"series": drama})

    def update_profile(self, payload: dict[str, object]) -> None:
        database = load_database()
        user = self.require_user(database)
        display_name = clean_text(payload.get("display_name"), 50, required=True)
        bio = clean_text(payload.get("bio", ""), 280)
        avatar = validate_image(payload.get("avatar"))
        current_password = payload.get("current_password", "")
        new_password = payload.get("new_password", "")
        if bool(current_password) != bool(new_password):
            raise ValueError("Informe a senha atual e a nova senha para alterar a senha.")
        if new_password:
            if not isinstance(current_password, str) or not password_matches(current_password, user["password"]):
                raise ValueError("A senha atual está incorreta.")
            if not isinstance(new_password, str) or len(new_password) < 10:
                raise ValueError("A nova senha deve ter pelo menos 10 caracteres.")
            user["password"] = password_record(new_password)
        user["display_name"] = display_name
        user["bio"] = bio
        if avatar:
            user["avatar"] = avatar
        save_database(database)
        self.send_json({"me": public_user(user)})

    def handle_recommendation(self, payload: dict[str, object]) -> None:
        database = load_database()
        user = self.require_user(database)
        target_user_id = payload.get("to_user_id")
        series_name = clean_text(payload.get("series"), 80, required=True)
        if not isinstance(target_user_id, str) or target_user_id not in database["users"]:
            raise ValueError("Selecione um membro válido para receber a recomendação.")
        if target_user_id == user["id"]:
            raise ValueError("Você não pode recomendar para si mesmo.")
        if not any(item["series"].strip().lower() == series_name.strip().lower() for item in database["episodes"] if isinstance(item.get("series"), str)):
            raise ValueError("Esse dorama não existe na biblioteca.")
        recommendation = {
            "id": str(uuid.uuid4()),
            "from_user_id": user["id"],
            "to_user_id": target_user_id,
            "series": series_name,
            "created": int(time.time() * 1000),
            "read": False,
        }
        database.setdefault("recommendations", []).append(recommendation)
        save_database(database)
        self.send_json({"recommendation": recommendation}, HTTPStatus.CREATED)


def main() -> None:
    load_database()
    server = ThreadingHTTPServer(("127.0.0.1", 8000), AppHandler)
    print("Clube do Episódio disponível em http://127.0.0.1:8000")
    print("Para sair, pressione Ctrl+C.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
