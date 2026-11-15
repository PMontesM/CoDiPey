FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

COPY requirements-prod.txt .
RUN pip install --no-cache-dir -r requirements-prod.txt

COPY main.py .
COPY templates ./templates
COPY public_files ./public_files

# Persistencia efímera en el contenedor; un solo singleton mantiene el estado
# mientras el contenedor esté despierto (sleepAfter largo en el Worker).
RUN mkdir -p /app/public_files /app/data
ENV DB_PATH=/app/data/hackathon.db

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
