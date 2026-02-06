"""
Sentinel-SDK: Dashboard Server
Serves the dashboard UI and provides API endpoints for audit and memory data.
"""

import http.server
import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/audit":
            self._serve_json(os.path.join(BASE_DIR, "audit.json"))
        elif self.path == "/api/memory":
            self._serve_json(os.path.join(BASE_DIR, "config", "bastion_memory.json"))
        elif self.path == "/" or self.path == "/index.html":
            self._serve_file(
                os.path.join(BASE_DIR, "dashboard", "index.html"),
                "text/html"
            )
        else:
            self.directory = os.path.join(BASE_DIR, "dashboard")
            super().do_GET()

    def _serve_json(self, filepath):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            with open(filepath, 'rb') as f:
                self.wfile.write(f.read())
        except (FileNotFoundError, json.JSONDecodeError):
            self.wfile.write(b"[]")

    def _serve_file(self, filepath, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            with open(filepath, 'rb') as f:
                self.wfile.write(f.read())
        except FileNotFoundError:
            self.wfile.write(b"<h1>File not found</h1>")

    def log_message(self, format, *args):
        # Suppress request logging noise
        pass


def main():
    port = int(os.getenv("DASHBOARD_PORT", "8080"))
    server = http.server.HTTPServer(("", port), DashboardHandler)
    print(f"{'=' * 50}")
    print(f"  Sentinel-SDK Dashboard")
    print(f"  http://localhost:{port}")
    print(f"{'=' * 50}")
    print(f"  API endpoints:")
    print(f"    GET /api/audit   -> audit.json")
    print(f"    GET /api/memory  -> bastion_memory.json")
    print(f"{'=' * 50}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDashboard server stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
