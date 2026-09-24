"""Security regression tests: HTTPS-only remote access, per-device logins, one-time codes, CA limits."""
import http.client, json, ssl, subprocess, sys, tempfile, threading, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import local_server
from local_tls import prepare
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

_orig_local = local_server.Handler.is_local
# Requests carrying this header are treated as coming from another device on the network.
local_server.Handler.is_local = lambda self: self.headers.get("X-Test-Remote") != "1" and _orig_local(self)


class Security(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(); root = Path(cls.temp.name)
        (root / "device-session-secret.txt").write_text("OLDSECRET")
        cls.http = local_server.make_server(cls.temp.name, 0, lan=True)
        cls.tls = prepare(cls.http.store.root)
        cls.https = local_server.make_server(cls.temp.name, 0, lan=True, store=cls.http.store, devices=cls.http.devices)
        cls.http.https_port = cls.https.https_port = cls.https.server_port
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cls.tls / "server.pem", cls.tls / "server-key.pem")
        cls.https.socket = ctx.wrap_socket(cls.https.socket, server_side=True)
        for s in (cls.http, cls.https):
            threading.Thread(target=s.serve_forever, daemon=True).start()
        cls.cctx = ssl.create_default_context(cafile=str(cls.tls / "ca.pem")); cls.cctx.check_hostname = False

    @classmethod
    def tearDownClass(cls):
        for s in (cls.http, cls.https):
            s.shutdown(); s.server_close()
        cls.temp.cleanup()

    def req(self, method, path, body=None, secure=True, remote=True, cookie=None, host=None):
        port = self.https.server_port if secure else self.http.server_port
        c = http.client.HTTPSConnection("127.0.0.1", port, context=self.cctx) if secure else http.client.HTTPConnection("127.0.0.1", port)
        h = {"Host": host or f"127.0.0.1:{port}", "X-ScrewShop": "1", "Content-Type": "application/json"}
        if remote: h["X-Test-Remote"] = "1"
        if cookie: h["Cookie"] = cookie
        c.request(method, path, json.dumps(body) if body is not None else None, h)
        r = c.getresponse(); data = r.read(); c.close()
        return r.status, r.headers, data

    def test_flow(self):
        s, h, _ = self.req("GET", "/barwork", secure=False); self.assertEqual(s, 308); self.assertTrue(h["Location"].startswith("https://"))
        self.assertEqual(self.req("GET", "/ScrewShop.mobileconfig", secure=False)[0], 200)
        self.assertEqual(self.req("POST", "/api/query", {"table": "songs"}, secure=False)[0], 403)
        self.assertEqual(self.req("POST", "/api/query", {"table": "songs"})[0], 401)
        self.assertEqual(self.req("GET", "/audio/beats/x.wav")[0], 401)
        self.assertEqual(self.req("POST", "/api/query", {"table": "songs"}, cookie="screwshop=OLDSECRET")[0], 200)
        code = self.http.devices.code
        self.assertEqual(self.req("POST", "/api/pair", {"code": "AAAA-AAAA"})[0], 401)
        s, h, _ = self.req("POST", "/api/pair", {"code": code.lower(), "name": "Friend"})
        self.assertEqual(s, 200); self.assertIn("Secure", h["Set-Cookie"]); self.assertIn("HttpOnly", h["Set-Cookie"])
        tok = h["Set-Cookie"].split(";")[0]
        self.assertEqual(self.req("POST", "/api/pair", {"code": code})[0], 401, "codes are one-time")
        self.assertEqual(self.req("POST", "/api/query", {"table": "songs"}, cookie=tok)[0], 200)
        self.assertEqual(self.req("GET", "/api/devices", cookie=tok)[0], 403)
        self.assertEqual(self.req("POST", "/api/devices", {"action": "remove_all"}, cookie=tok)[0], 403)
        s, _, d = self.req("GET", "/api/devices", secure=False, remote=False)
        devices = json.loads(d)["data"]["devices"]; self.assertEqual(len(devices), 2); self.assertNotIn("token", d.decode())
        friend = next(x for x in devices if x["name"] == "Friend")
        self.req("POST", "/api/devices", {"action": "remove", "id": friend["id"]}, secure=False, remote=False)
        self.assertEqual(self.req("POST", "/api/query", {"table": "songs"}, cookie=tok)[0], 401)
        self.req("POST", "/api/devices", {"action": "remove_all"}, secure=False, remote=False)
        self.assertEqual(self.req("POST", "/api/query", {"table": "songs"}, cookie="screwshop=OLDSECRET")[0], 401)
        self.assertEqual([self.req("POST", "/api/pair", {"code": "ZZZZ-ZZZZ"})[0] for _ in range(11)][-1], 429)
        self.assertEqual(self.req("GET", "/barwork", secure=False, host="evil.example:1")[0], 403)

    def test_ca_cannot_vouch_for_public_sites(self):
        ca = x509.load_pem_x509_certificate((self.tls / "ca.pem").read_bytes())
        key = serialization.load_pem_private_key((self.tls / "ca-key.pem").read_bytes(), None)
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        now = datetime.now(timezone.utc)
        forged = (x509.CertificateBuilder().subject_name(x509.Name([])).issuer_name(ca.subject).public_key(other.public_key())
                  .serial_number(7).not_valid_before(now).not_valid_after(now + timedelta(days=5))
                  .add_extension(x509.SubjectAlternativeName([x509.DNSName("www.chase.com")]), critical=False).sign(key, hashes.SHA256()))
        path = Path(self.temp.name) / "forged.pem"; path.write_bytes(forged.public_bytes(serialization.Encoding.PEM))
        try:
            run = subprocess.run(["openssl", "verify", "-CAfile", str(self.tls / "ca.pem"), str(path)], capture_output=True, text=True)
        except FileNotFoundError:
            self.skipTest("openssl not installed")
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("subtree", run.stdout + run.stderr)


if __name__ == "__main__":
    unittest.main()
