import requests

URL = "http://127.0.0.1:8001/api/self/patch"
TOKEN = "change_me_secure_token"

headers = {
    "X-Admin-Token": TOKEN,
    "Content-Type": "application/json"
}

print("Lecture du fichier...")
with open("sirius_brain.py", "r", encoding="utf-8") as f:
    original = f.read()

payload = {
    "file_path": "sirius_brain.py",
    "content": "# PATCH TEST OK\n" + original
}

print("Envoi de la requête de patch...")
response = requests.post(URL, headers=headers, json=payload)
print(f"Statut HTTP : {response.status_code}")
print(f"Réponse : {response.json()}")