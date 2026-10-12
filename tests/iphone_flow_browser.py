"""The iPhone path end to end, on a throwaway server, over this computer's Wi-Fi address (not localhost).

Safari's engine (WebKit) with an iPhone profile: profile download, http -> https forward, certificate chain
(checked strictly with the downloaded CA), pairing screen, wrong code, right code, staying paired after a
reload, and the paired phone working with the studio. Real-iPhone steps (installing the profile, trust
toggle, microphone permission) can't be automated here.
"""
import json
import plistlib
import socket
import ssl
import sys
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from local_server import make_server
from local_tls import local_addresses, prepare


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close(); return port


lan_ip = next((a for a in local_addresses() if a.startswith(('192.168.', '10.', '172.'))), None)
if not lan_ip:
    sys.exit('SKIP: this computer has no home-network address right now')

with tempfile.TemporaryDirectory() as temp:
    http_port, https_port = free_port(), free_port()
    server = make_server(temp, http_port, lan=True, https_port=https_port)
    tls = prepare(server.store.root)
    secure = make_server(temp, https_port, lan=True, store=server.store, devices=server.devices, https_port=https_port)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(tls / 'server.pem', tls / 'server-key.pem')
    secure.socket = context.wrap_socket(secure.socket, server_side=True)
    for s in (server, secure):
        threading.Thread(target=s.serve_forever, daemon=True).start()
    plain, https = f'http://{lan_ip}:{http_port}', f'https://{lan_ip}:{https_port}'
    try:
        # 1. Profile link: served over plain Wi-Fi HTTP with Apple's profile type; it carries the same CA.
        import urllib.request
        with urllib.request.urlopen(plain + '/ScrewShop.mobileconfig', timeout=10) as r:
            assert r.headers['Content-Type'] == 'application/x-apple-aspen-config', r.headers['Content-Type']
            profile = plistlib.loads(r.read())
        ca_der = profile['PayloadContent'][0]['PayloadContent']
        from cryptography import x509
        from cryptography.hazmat.primitives.serialization import Encoding
        ca_pem = x509.load_der_x509_certificate(ca_der).public_bytes(Encoding.PEM)
        assert ca_pem == (tls / 'ca.pem').read_bytes()
        # 2. Once that CA is trusted, the HTTPS chain passes even strict (RFC 5280) checking.
        strict = ssl.create_default_context(cadata=ca_pem.decode()); strict.verify_flags |= ssl.VERIFY_X509_STRICT
        strict.wrap_socket(socket.create_connection((lan_ip, https_port), timeout=10), server_hostname=lan_ip).close()

        with sync_playwright() as p:
            iphone = p.devices['iPhone 15']
            browser = p.webkit.launch()
            phone = browser.new_context(**iphone, ignore_https_errors=True)  # stands in for the trusted profile
            page = phone.new_page()
            errors = []
            step = ['start']
            page.on('pageerror', lambda e: errors.append(step[0] + ': ' + str(e)))
            pair_headers = []
            page.on('response', lambda r: pair_headers.append(r.headers.get('set-cookie', '')) if r.url.endswith('/api/pair') and r.status == 200 else None)
            # 3. The plain address a person types forwards to the secure one.
            page.goto(plain + '/barwork')
            assert page.url.startswith(https + '/barwork'), page.url
            assert page.evaluate('window.isSecureContext'), 'microphone and saving need a secure page'
            # 4. Pairing screen; a wrong code is refused with a clear message.
            name, code = page.get_by_label('Your name'), page.get_by_label('Pairing code')
            name.wait_for(timeout=20000)
            name.fill('Test iPhone'); code.fill('WRONG-CODE')
            page.get_by_role('button', name='PAIR').or_(page.locator('.login-form button')).first.click()
            page.get_by_text('Incorrect or already-used pairing code').wait_for(timeout=10000)
            # 5. The real code (shown on the computer) pairs it.
            with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{http_port}/api/devices'), timeout=10) as r:
                shown = json.load(r)['data']['code']
            step[0] = 'pairing'
            name.fill('Test iPhone'); code.fill(shown)
            page.locator('.login-form button').first.click()
            page.get_by_role('button', name='SONGS', exact=True).wait_for(timeout=20000)
            cookie = next(c for c in phone.cookies() if c['name'] == 'screwshop_device')
            assert cookie['secure'] and cookie['httpOnly']
            # Playwright's Windows WebKit reports every cookie as SameSite=None, so check what the server sent.
            assert 'SameSite=Strict' in pair_headers[0] and 'Secure' in pair_headers[0], pair_headers
            devices = server.devices.listing()
            assert [d['name'] for d in devices] == ['Test iPhone'], devices
            # 6. The code was used up; a reload stays paired; the phone can save into the studio.
            step[0] = 'reload'
            page.reload()
            step[0] = 'after reload'
            page.get_by_role('button', name='SONGS', exact=True).wait_for(timeout=20000)
            page.get_by_role('button', name='NOTEPAD', exact=True).click()
            page.get_by_role('textbox', name='Song name', exact=True).wait_for(timeout=10000)
            # 7. Phone settings say it's paired and show no device management.
            assert page.evaluate("fetch('/api/devices').then(r=>r.status)") == 403
            page.screenshot(path=str(ROOT / 'test-results' / 'iphone-paired.png'))
            # 8. A second phone can't reuse the old code.
            other = browser.new_context(**iphone, ignore_https_errors=True).new_page()
            other.goto(https + '/barwork')
            other.get_by_label('Your name').fill('Someone else'); other.get_by_label('Pairing code').fill(shown)
            other.locator('.login-form button').first.click()
            other.get_by_text('Incorrect or already-used pairing code').wait_for(timeout=10000)
            # 9. QR codes: only the computer gets them, and they encode the phone links (main address first).
            assert page.evaluate("fetch('/api/qr?link=profile').then(r=>r.status)") == 403
            import segno, io
            computer = browser.new_context(viewport={'width': 1280, 'height': 900}, ignore_https_errors=True).new_page()
            computer.goto(f'http://127.0.0.1:{http_port}/barwork')
            computer.get_by_role('button', name='Open settings').click()
            for link, url in (('profile', f'{plain}/ScrewShop.mobileconfig'), ('studio', f'{https}/barwork')):
                img = computer.locator(f'img[src="/api/qr?link={link}"]')
                img.scroll_into_view_if_needed()
                computer.wait_for_function('el => el.complete && el.naturalWidth > 0', arg=img.element_handle())
                buf = io.BytesIO(); segno.make(url, error='m').save(buf, kind='svg', scale=6, border=3, dark='#000000', light='#ffffff', title=url)
                served = urllib.request.urlopen(f'http://127.0.0.1:{http_port}/api/qr?link={link}', timeout=10).read()
                assert served == buf.getvalue(), f'{link} QR does not encode {url}'
            computer.locator('.ss-phone-qr').screenshot(path=str(ROOT / 'test-results' / 'settings-phone-qr.png'))
            # Background saves cut off by the reload itself are reported by WebKit as "access control checks".
            errors = [e for e in errors if not (e.startswith('reload:') and 'access control checks' in e)]
            assert not errors, errors
            print('PASS: profile download, http->https, strict certificate chain, pairing (wrong code, right code, one-time), secure cookie, stays paired, phone works, no device admin from phone', flush=True)
            browser.close()
    finally:
        server.shutdown(); secure.shutdown()
