FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir sentence-transformers==5.1.2 transformers==4.57.1
COPY server.py ./server.py
ENV HF_HOME=/models TOKENIZERS_PARALLELISM=false EMBED_THREADS=2
EXPOSE 8090
CMD ["python", "server.py"]
