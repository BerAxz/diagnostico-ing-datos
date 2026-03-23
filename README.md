# Diagnóstico Ingeniería de Datos - Miner + Visualizer

Herramienta para identificar en tiempo real las palabras más utilizadas en nombres de métodos/funciones de código Python y Java publicado en GitHub.

## Arquitectura

- `miner` (Python): productor que consulta GitHub, extrae palabras y las publica en Redis.
- `visualizer` (JavaScript): consumidor que escucha Redis, acumula frecuencias y muestra ranking en tiempo real.
- `redis`: cola/canal de mensajería para el modelo productor-consumidor.

## Cumplimiento del enunciado

- El miner procesa repositorios por popularidad (`stars`, descendente).
- Se toma `top 5` repositorios por página para `java` y `top 5` para `python`.
- El proceso es continuo hasta detener manualmente.
- Se extraen palabras desde nombres con convenciones `snake_case` y `camelCase`.
- El visualizer actualiza en tiempo real y permite parametrizar `Top-N` desde la UI.

## Requisitos

- Docker + Docker Compose
- (Opcional pero recomendado) `GITHUB_TOKEN` en archivo `.env` en la raíz:

```env
GITHUB_TOKEN=tu_token_de_github
```

## Ejecución (un solo comando)

```bash
docker compose up --build
```

Luego abre:

- Visualizer: http://localhost:3000

## Estructura

- `miner/miner.py`
- `miner/Dockerfile`
- `visualizer/server.js`
- `visualizer/public/index.html`
- `visualizer/public/app.js`
- `visualizer/Dockerfile`
- `docker-compose.yml`

## Decisiones de diseño

- Redis Pub/Sub para desacoplar componentes y compartir datos inmediatamente.
- Agregación de conteos en memoria en el visualizer para refresco rápido.
- Visualización con `Chart.js` por simplicidad y legibilidad (total, python, java).

## Supuestos

- El rate limit de GitHub mejora usando token personal.
- El ranking se construye a partir de palabras individuales extraídas de identificadores.
