import os

backend_dir = r"C:\ZEUS-S-I-R-I-U-S-SIRIUS-HACCP-forms-2026\backend"
server_py_path = os.path.join(backend_dir, "server.py")

if os.path.exists(server_py_path):
    print("Found server.py")
    with open(server_py_path, "r", encoding="utf-8") as f:
        content = f.read()
    print("--- Length:", len(content))
    print(content[:2000]) # Print first 2000 chars
else:
    print("server.py not found at", server_py_path)
