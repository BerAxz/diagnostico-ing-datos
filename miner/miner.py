import requests
import os
from dotenv import load_dotenv
import ast
import re
import time
import warnings
import json
import redis
import logging

warnings.filterwarnings('ignore', category=SyntaxWarning)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger(__name__)

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

GITHUB_TOKEN  = os.getenv('GITHUB_TOKEN')
REDIS_HOST    = os.getenv('REDIS_HOST', 'localhost')
REDIS_PORT    = int(os.getenv('REDIS_PORT', '6379'))
REDIS_CHANNEL = os.getenv('REDIS_CHANNEL', 'miner_words')

# Cuántos repos se piden por lenguaje en cada "ronda"
REPOS_PER_BATCH = int(os.getenv('REPOS_PER_BATCH', '5'))

# Segundos de espera entre repositorios para no agotar el rate-limit
SLEEP_BETWEEN_REPOS = float(os.getenv('SLEEP_BETWEEN_REPOS', '1'))

# Segundos de espera entre rondas completas (java + python)
SLEEP_BETWEEN_ROUNDS = float(os.getenv('SLEEP_BETWEEN_ROUNDS', '10'))

headers = {'Accept': 'application/vnd.github.v3+json'}
if GITHUB_TOKEN:
    headers['Authorization'] = f'token {GITHUB_TOKEN}'


# ──────────────────────────────────────────────
# Redis
# ──────────────────────────────────────────────

def get_redis_client():
    try:
        client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
        client.ping()
        log.info("Conectado a Redis en %s:%s, canal '%s'.", REDIS_HOST, REDIS_PORT, REDIS_CHANNEL)
        return client
    except redis.RedisError as exc:
        log.warning("No se pudo conectar a Redis: %s. Las palabras NO se publicarán.", exc)
        return None


def publish_words(redis_client, words, language, repo, file_path):
    """Publica cada palabra extraída como un mensaje JSON en el canal Redis."""
    if not redis_client or not words:
        return
    for word in words:
        if not word or len(word) < 2:   # ignorar palabras vacías o de 1 letra
            continue
        payload = json.dumps({
            'word':       word,
            'language':   language,
            'repository': repo,
            'file':       file_path,
        })
        try:
            redis_client.publish(REDIS_CHANNEL, payload)
        except redis.RedisError as exc:
            log.error("Error publicando en Redis: %s", exc)


# ──────────────────────────────────────────────
# Extracción de palabras
# ──────────────────────────────────────────────

def split_identifier(name: str) -> list[str]:
    """
    Divide un identificador camelCase / snake_case en palabras individuales.
    Ejemplos:
        'getUserName'  -> ['get', 'user', 'name']
        'make_response'-> ['make', 'response']
        'retainAll'    -> ['retain', 'all']
    """
    # Separar camelCase / PascalCase (inserta espacio antes de cada mayúscula precedida por minúscula)
    spaced = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', name)
    # Reemplazar guiones bajos y otros separadores por espacio
    spaced = re.sub(r'[_\-\s]+', ' ', spaced)
    return [w.lower() for w in spaced.split() if w.isalpha()]


def extract_python_methods(content: str) -> list[str]:
    """Extrae palabras de nombres de funciones Python usando el módulo ast."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', SyntaxWarning)
            tree = ast.parse(content)
        words = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                words.extend(split_identifier(node.name))
        return words
    except SyntaxError:
        return []


# Palabras de control de flujo y keywords Java que NUNCA son nombres de método
_JAVA_CONTROL_FLOW = {
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
    'continue', 'return', 'throw', 'try', 'catch', 'finally',
    'new', 'instanceof', 'import', 'package', 'assert',
}

# Regex anclada a inicio de línea:
#   1. Anotaciones opcionales (@Override, @Bean, etc.)
#   2. Modificadores opcionales (public, static, final, …)
#   3. Tipo genérico opcional (<T>)
#   4. Tipo de retorno  → capturado en grupo 1 para validación posterior
#   5. Nombre de método → capturado en grupo 2, DEBE empezar con minúscula
#      (convención Java: los constructores empiezan con mayúscula, los métodos no)
_JAVA_METHOD_RE = re.compile(
    r'^\s*'
    r'(?:@\w+(?:\s*\([^)]*\))?\s*\n?\s*)*'           # anotaciones
    r'(?:(?:public|protected|private|static|final|'
    r'synchronized|abstract|native|default|strictfp)\s+)*'
    r'(?:(?:<[^>]+>\s+)?)'                            # tipo genérico: <T>
    r'([\w<>\[\].,\s]+?)'                             # grupo 1: tipo de retorno
    r'\s+'
    r'([a-z][a-zA-Z0-9_$]*)'                         # grupo 2: nombre (minúscula inicial)
    r'\s*\(',
    re.MULTILINE,
)

def extract_java_methods(content: str) -> list[str]:
    """
    Extrae palabras de nombres de métodos Java usando expresiones regulares.
    Ancla la búsqueda al inicio de línea y exige que el nombre empiece con
    minúscula (convención Java), lo que elimina casi todos los falsos positivos
    de control de flujo como if(...), for(...), while(...).
    """
    words = []
    for match in _JAVA_METHOD_RE.finditer(content):
        return_type = match.group(1).strip().lower()
        name        = match.group(2)

        # Descartar si el "tipo de retorno" capturado es en realidad
        # una keyword de control de flujo (if, for, while, …)
        if return_type in _JAVA_CONTROL_FLOW:
            continue
        # Descartar si el nombre mismo es una keyword
        if name in _JAVA_CONTROL_FLOW:
            continue

        words.extend(split_identifier(name))
    return words


# ──────────────────────────────────────────────
# GitHub helpers
# ──────────────────────────────────────────────

def _get(url: str, timeout: int = 20):
    """GET con manejo básico de rate-limit (429 / 403 con X-RateLimit-Reset)."""
    try:
        resp = requests.get(url, headers=headers, timeout=timeout)
    except requests.RequestException as exc:
        log.warning("Error de red: %s", exc)
        return None

    if resp.status_code in (403, 429):
        reset_ts = resp.headers.get('X-RateLimit-Reset')
        wait = 60
        if reset_ts:
            wait = max(int(reset_ts) - int(time.time()) + 5, 5)
        log.warning("Rate limit alcanzado. Esperando %ds...", wait)
        time.sleep(wait)
        return None

    return resp


def fetch_top_repositories(language: str, page: int, per_page: int = 5):
    """Obtiene repositorios ordenados por estrellas para un lenguaje."""
    url = (
        f"https://api.github.com/search/repositories"
        f"?q=language:{language}&sort=stars&order=desc"
        f"&per_page={per_page}&page={page}"
    )
    resp = _get(url)
    if resp is None or resp.status_code != 200:
        return []
    return resp.json().get('items', [])


def get_file_tree(repo_full_name: str) -> tuple[list, str]:
    """Devuelve (árbol, ref) del repo; prueba 'main' si 'master' falla."""
    for ref in ('main', 'master'):
        url = f"https://api.github.com/repos/{repo_full_name}/git/trees/{ref}?recursive=1"
        resp = _get(url)
        if resp and resp.status_code == 200:
            return resp.json().get('tree', []), ref
    return [], ''


def process_repository(repo_full_name: str, redis_client):
    """Descarga y analiza archivos .py y .java de un repositorio."""
    log.info("  → Procesando: %s", repo_full_name)
    tree, ref = get_file_tree(repo_full_name)

    if not tree:
        log.warning("    No se pudo obtener el árbol de %s", repo_full_name)
        return

    target_files = [
        item['path'] for item in tree
        if item['path'].endswith(('.py', '.java'))
        and item.get('type') == 'blob'
    ]

    log.info("    Archivos encontrados: %d", len(target_files))

    for file_path in target_files:
        raw_url = (
            f"https://raw.githubusercontent.com/{repo_full_name}/{ref}/{file_path}"
        )
        resp = _get(raw_url)
        if resp is None or resp.status_code != 200:
            continue

        if file_path.endswith('.py'):
            words    = extract_python_methods(resp.text)
            language = 'python'
        else:
            words    = extract_java_methods(resp.text)
            language = 'java'

        if words:
            publish_words(redis_client, words, language, repo_full_name, file_path)
            log.info("    %s → %d palabras extraídas", file_path, len(words))


# ──────────────────────────────────────────────
# Loop principal
# ──────────────────────────────────────────────

def run_miner():
    """
    Ejecuta el miner de forma continua:
    - Avanza página a página (repos más populares primero)
    - Se detiene sólo con Ctrl-C o señal del SO
    """
    if not GITHUB_TOKEN:
        log.warning("GITHUB_TOKEN no configurado — rate limit muy bajo (60 req/h).")

    redis_client = get_redis_client()

    # Página actual por lenguaje (avanza indefinidamente)
    pages = {'java': 1, 'python': 1}

    log.info("Miner iniciado. Presiona Ctrl-C para detener.")

    while True:
        for language in ('java', 'python'):
            page = pages[language]
            log.info("Buscando top %d repos de %s (página %d)…",
                     REPOS_PER_BATCH, language, page)

            repos = fetch_top_repositories(language, page, per_page=REPOS_PER_BATCH)

            if not repos:
                log.warning("Sin resultados para %s pág %d. Reintentando en 60s.", language, page)
                time.sleep(60)
                continue

            for repo in repos:
                process_repository(repo['full_name'], redis_client)
                time.sleep(SLEEP_BETWEEN_REPOS)

            pages[language] += 1

        log.info("Ronda completada. Esperando %ds antes de la siguiente…", SLEEP_BETWEEN_ROUNDS)
        time.sleep(SLEEP_BETWEEN_ROUNDS)


if __name__ == '__main__':
    try:
        run_miner()
    except KeyboardInterrupt:
        log.info("Miner detenido por el usuario.")