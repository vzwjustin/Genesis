docker stop genesis
docker rm genesis
docker build -t genesis .
docker run -d --name genesis -p 20128:20128 --env-file .env -v genesis-data:/app/data genesis