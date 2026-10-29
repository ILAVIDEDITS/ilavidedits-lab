"""Static server for the lab (reachable from your phone on the same Wi-Fi). `python3 serve.py [port]`. POST /save-glb writes ilavidedits-lab.glb here."""
import http.server, os, sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/save-glb' or self.client_address[0] not in ('127.0.0.1', '::1'):
            return self.send_error(404)
        data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        with open('ilavidedits-lab.glb', 'wb') as f:
            f.write(data)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


http.server.ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1]) if len(sys.argv) > 1 else 5173), Handler).serve_forever()
