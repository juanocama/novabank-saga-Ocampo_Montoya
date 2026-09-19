FROM prefecthq/prefect:2.19-python3.11
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY flow.py ./
EXPOSE 8000
CMD ["uvicorn", "flow:app", "--host", "0.0.0.0", "--port", "8000"]
