import os
import redis
from rq import Worker, Queue

# Import the application module so the worker can find task functions
# (RQ serializes function paths like "backend.background_extract_and_save_thumbnail").
import backend  # noqa: F401

REDIS_URL = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')

if __name__ == '__main__':
    redis_conn = redis.from_url(REDIS_URL)
    listen = ['default']
    queues = [Queue(name, connection=redis_conn) for name in listen]
    worker = Worker(queues, connection=redis_conn)
    worker.work()
