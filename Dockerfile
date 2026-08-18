# Use a slim Python image for a smaller footprint
FROM python:3.11-slim

# Prevent Python from writing .pyc files and enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install system dependencies (FFmpeg is critical for your thumbnails!)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /backend

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the AI model so it doesn't download every time the app starts
RUN python -c "from transformers import ViTImageProcessor, ViTForImageClassification; \
    ViTImageProcessor.from_pretrained('google/vit-base-patch16-224'); \
    ViTForImageClassification.from_pretrained('google/vit-base-patch16-224')"

# Copy the rest of your code
COPY . .

# Expose the Flask port
EXPOSE 5000

# This is the default command, but we'll override it in docker-compose for the worker
CMD ["python", "backend.py"]