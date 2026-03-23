import requests
import os
from dotenv import load_dotenv
import ast
import re
import time
import warnings
import json
import redis

warnings.filterwarnings('ignore', category=SyntaxWarning)

# Carga las variables de entorno desde el archivo .env
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

GITHUB_TOKEN = os.getenv('GITHUB_TOKEN')
REDIS_HOST = os.getenv('REDIS_HOST', 'localhost')
REDIS_PORT = int(os.getenv('REDIS_PORT', '6379'))
REDIS_CHANNEL = os.getenv('REDIS_CHANNEL', 'miner_words')

headers = {
    'Accept': 'application/vnd.github.v3+json'
}

if GITHUB_TOKEN:
    headers['Authorization'] = f'token {GITHUB_TOKEN}'


def get_redis_client():
    try:
        client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
        client.ping()
        return client
    except redis.RedisError as exc:
        print(f"No se pudo conectar a Redis ({REDIS_HOST}:{REDIS_PORT}): {exc}")
        return None

def split_identifier(name):
    """
    Divide nombres en camelCase y snake_case a una lista de palabras.
    Ejemplo: 'get_userName' -> ['get', 'user', 'name']
    """
    # Insertar espacio antes de mayúsculas y limpiar guiones bajos
    words = re.sub(r'([a-z])([A-Z])', r'\1 \2', name).replace('_', ' ').split()
    return [w.lower() for w in words]

def extract_python_methods(content):
    """Analiza código Python usando AST para extraer nombres de funciones."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', SyntaxWarning)
            tree = ast.parse(content)
        methods = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                methods.extend(split_identifier(node.name))
        return methods
    except SyntaxError:
        return []

def extract_java_methods(content):
    """Extrae nombres de métodos Java usando Regex (simulando AST)."""
    # Regex para capturar el nombre del método antes del paréntesis
    pattern = r'(?:public|protected|private|static|\s) +[\w\<\>\[\]]+\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\('
    names = re.findall(pattern, content)
    all_words = []
    for name in names:
        all_words.extend(split_identifier(name))
    return list(set(all_words)) # Eliminar duplicados simples

def process_repository(repo_full_name, redis_client):
    """Busca archivos .py y .java en un repositorio y extrae palabras."""
    print(f"  --> Procesando: {repo_full_name}")
    # Usamos la API de contenidos (recursiva)
    ref = 'master'
    url = f"https://api.github.com/repos/{repo_full_name}/git/trees/{ref}?recursive=1"
    try:
        res = requests.get(url, headers=headers, timeout=20)
    except requests.RequestException as exc:
        print(f"      Error de red leyendo árbol de {repo_full_name}: {exc}")
        return
    
    if res.status_code != 200: # Reintentar con 'main' si 'master' falla
        ref = 'main'
        url = f"https://api.github.com/repos/{repo_full_name}/git/trees/{ref}?recursive=1"
        try:
            res = requests.get(url, headers=headers, timeout=20)
        except requests.RequestException as exc:
            print(f"      Error de red leyendo árbol de {repo_full_name}: {exc}")
            return

    if res.status_code == 200:
        tree = res.json().get('tree', [])
        for item in tree:
            file_path = item['path']
            if file_path.endswith(('.py', '.java')):
                # Descargar contenido del archivo
                raw_url = f"https://raw.githubusercontent.com/{repo_full_name}/{ref}/{file_path}"
                try:
                    file_res = requests.get(raw_url, timeout=20)
                except requests.RequestException:
                    continue
                if file_res.status_code == 200:
                    words = []
                    if file_path.endswith('.py'):
                        words = extract_python_methods(file_res.text)
                    else:
                        words = extract_java_methods(file_res.text)
                    
                    if words:
                        if redis_client:
                            for word in words:
                                payload = {
                                    'word': word,
                                    'language': 'python' if file_path.endswith('.py') else 'java',
                                    'repository': repo_full_name,
                                    'file': file_path,
                                }
                                redis_client.publish(REDIS_CHANNEL, json.dumps(payload))
                        print(f"      Extraídas {len(words)} palabras de {file_path}")
    else:
        print(f"      No se pudo leer el árbol de {repo_full_name} (status {res.status_code})")

def fetch_top_repositories(language, page, per_page=5):
    """Obtiene repositorios ordenados por stars para un lenguaje específico."""
    url = (
        f"https://api.github.com/search/repositories"
        f"?q=language:{language}&sort=stars&order=desc&per_page={per_page}&page={page}"
    )
    response = requests.get(url, headers=headers, timeout=20)
    if response.status_code != 200:
        return []
    return response.json().get('items', [])

def run_miner():
    """Ejecución continua buscando repositorios por popularidad."""
    if not GITHUB_TOKEN:
        print("Aviso: GITHUB_TOKEN no está configurado. Podrías alcanzar rate limits rápidamente.")

    redis_client = get_redis_client()
    if redis_client:
        print(f"Conectado a Redis en {REDIS_HOST}:{REDIS_PORT}, canal '{REDIS_CHANNEL}'.")
    else:
        print("Continuando sin publicar datos en tiempo real.")

    pages = {
        'java': 1,
        'python': 1,
    }

    while True:
        for language in ('java', 'python'):
            page = pages[language]
            print(f"Buscando top 5 repositorios de {language} (Página {page})...")
            try:
                repos = fetch_top_repositories(language, page, per_page=5)
            except requests.RequestException as exc:
                print(f"Error de red buscando repositorios de {language}: {exc}")
                time.sleep(30)
                continue

            if not repos:
                print(f"Esperando por Rate Limit o sin datos para {language}...")
                time.sleep(60)
                continue

            for repo in repos:
                process_repository(repo['full_name'], redis_client)
                time.sleep(1) # Evitar baneo de Rate Limit

            pages[language] += 1

if __name__ == "__main__":
    try:
        run_miner()
    except KeyboardInterrupt:
        print("Miner detenido por el usuario.")