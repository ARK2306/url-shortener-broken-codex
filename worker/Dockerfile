FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY worker.py ./

HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=10s \
  CMD ["python", "worker.py", "--healthcheck"]

CMD ["python", "worker.py"]
