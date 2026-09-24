"""Verify the live private HTTPS endpoint, including real non-loopback pairing."""
import http.cookiejar
import json
import socket
import ssl
import urllib.error
import urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
addresses = socket.gethostbyname_ex(socket.gethostname())[2]
address = next((a for a in addresses if a.startswith('192.168.')), addresses[0])
base = f'https://{address}:5443'
context = ssl.create_default_context(cafile=str(ROOT / 'data/tls/ca.pem'))
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context), urllib.request.HTTPCookieProcessor(jar))
with opener.open(base + '/api/status', timeout=10) as response:
    assert json.load(response)['paired'] is False
query = json.dumps({'table':'songs'}).encode()
try:
    opener.open(urllib.request.Request(base+'/api/query',data=query,headers={'X-ScrewShop':'1','Content-Type':'application/json'}))
    raise AssertionError('Unpaired device read private songs')
except urllib.error.HTTPError as error:
    assert error.code == 401
code = (ROOT / 'data/phone-pairing-code.txt').read_text().strip()
with opener.open(urllib.request.Request(base+'/api/pair',data=json.dumps({'code':code,'name':'Automated phone check (safe to remove)'}).encode(),headers={'X-ScrewShop':'1','Content-Type':'application/json','Origin':base})) as response:
    assert response.status == 200
    assert '; Secure' in response.headers['Set-Cookie']
with opener.open(urllib.request.Request(base+'/api/query',data=query,headers={'X-ScrewShop':'1','Content-Type':'application/json','Origin':base})) as response:
    assert response.status == 200
for path in ['/data/tls/ca-key.pem','/data/phone-pairing-code.txt']:
    try:
        opener.open(base+path)
        raise AssertionError('Private file exposed')
    except urllib.error.HTTPError as error:
        assert error.code == 404
print('HTTPS certificate verified; unpaired access denied; pairing succeeds; secure cookie; private keys inaccessible.')
