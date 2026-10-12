"""Per-computer certificate authority for optional private iPhone access.

Only the public certificate is downloadable. Private keys stay outside the web root.
Trust is installed by the owner on the phone, never changed automatically.

The CA carries X.509 name constraints: it can only vouch for private/home network
addresses, localhost, this computer's name and its Tailscale name. Even if its key
leaked, it could not be used to impersonate a bank or any public website.
Older CAs made without those limits are retired automatically (the phone then
needs the new profile once).
"""
import time
import ipaddress
import plistlib
import socket
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID



def local_addresses():
    """This computer's IPv4 addresses; never crashes if name lookup fails (e.g. network not up yet)."""
    found = set()
    try:
        found.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    try:  # the address used to reach the local network, without sending anything
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("192.168.0.1", 9))
        found.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass
    return sorted(a for a in found if not a.startswith("0."))


def primary_address():
    """The address phones should use: the one this computer reaches the home network with (not WSL/Hyper-V adapters)."""
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("192.168.0.1", 9))  # picks the route; nothing is sent
        address = probe.getsockname()[0]
        probe.close()
        return address
    except OSError:
        return None


PRIVATE_NETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16"]


def _constraints(ca):
    try:
        return ca.extensions.get_extension_for_class(x509.NameConstraints).value
    except x509.ExtensionNotFound:
        return None


def _has_ski(cert):
    try:
        cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier)
        return True
    except x509.ExtensionNotFound:
        return False


def _permitted_dns(ca):
    nc = _constraints(ca)
    return [g.value.lower() for g in (nc.permitted_subtrees or []) if isinstance(g, x509.DNSName)] if nc else []


def _dns_ok(name, permitted):
    name = name.lower()
    return any(name == p or name.endswith("." + p) for p in permitted)


def prepare(data, extra_names=(), extra_ips=()):
    folder = Path(data) / "tls"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc)
    root_key_path, root_cert_path = folder / 'ca-key.pem', folder / 'ca.pem'
    host = socket.gethostname().lower()
    # Tailscale names are covered by Tailscale's own public certificate, so they are not added here;
    # installing Tailscale later never forces a new iPhone profile.
    wanted_dns = sorted({"localhost", host})
    if root_key_path.exists() and root_cert_path.exists():
        root_key = serialization.load_pem_private_key(root_key_path.read_bytes(), password=None)
        ca = x509.load_pem_x509_certificate(root_cert_path.read_bytes())
        # Also retire a CA without a Subject Key Identifier: strict (RFC 5280) validators reject its chain.
        if _constraints(ca) is None or not all(_dns_ok(n, _permitted_dns(ca)) for n in wanted_dns) or not _has_ski(ca):
            # Retire the old unrestricted CA: keep its public certificate for reference, destroy its private key.
            retired = folder / ("retired-" + time.strftime("%Y%m%d-%H%M%S"))
            retired.mkdir()
            root_cert_path.replace(retired / "ca.pem")
            (folder / "fingerprint.txt").exists() and (folder / "fingerprint.txt").replace(retired / "fingerprint.txt")
            root_key_path.unlink()
            (retired / "README.txt").write_text("Retired ScrewShop certificate. Remove the old 'ScrewShop Local Connection' profile from your iPhone and install the new one.\n", encoding="utf-8")
            return prepare(data, extra_names, extra_ips)
    else:
        root_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'ScrewShop Private Local CA')])
        ca = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(root_key.public_key())
              .serial_number(x509.random_serial_number()).not_valid_before(stamp - timedelta(days=1))
              .not_valid_after(stamp + timedelta(days=1825)).add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
              .add_extension(x509.NameConstraints(
                  permitted_subtrees=[x509.DNSName(n) for n in wanted_dns] + [x509.IPAddress(ipaddress.ip_network(n)) for n in PRIVATE_NETS],
                  excluded_subtrees=None), critical=True)
              .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False, data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
              .add_extension(x509.SubjectKeyIdentifier.from_public_key(root_key.public_key()), critical=False)
              .sign(root_key, hashes.SHA256()))
        root_key_path.write_bytes(root_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        root_cert_path.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    permitted_dns = _permitted_dns(ca)
    nets = [ipaddress.ip_network(n) for n in PRIVATE_NETS]
    hosts = sorted({'localhost', host, '127.0.0.1', *local_addresses(), *[n.lower() for n in extra_names if n], *extra_ips})
    sans = []
    for name in hosts:
        try:
            ip = ipaddress.ip_address(name)
            if ip.version == 4 and any(ip in net for net in nets):
                sans.append(x509.IPAddress(ip))
        except ValueError:
            if _dns_ok(name, permitted_dns):
                sans.append(x509.DNSName(name))
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'ScrewShop')]))
            .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(stamp - timedelta(days=1)).not_valid_after(stamp + timedelta(days=365))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            # RFC 5280 key identifiers: strict validators reject a server certificate without them.
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca.public_key()), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=True, data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .sign(root_key, hashes.SHA256()))
    (folder / 'server-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (folder / 'server.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    profile = {'PayloadType': 'Configuration', 'PayloadVersion': 1, 'PayloadIdentifier': 'local.screwshop.certificate', 'PayloadUUID': str(uuid.uuid4()), 'PayloadDisplayName': 'ScrewShop Local Connection', 'PayloadDescription': 'Trust the private ScrewShop server on your own computer. This installs a certificate only; it does not enroll or manage your phone.', 'PayloadContent': [{'PayloadType': 'com.apple.security.root', 'PayloadVersion': 1, 'PayloadIdentifier': 'local.screwshop.certificate.root', 'PayloadUUID': str(uuid.uuid4()), 'PayloadDisplayName': 'ScrewShop Private Local CA', 'PayloadContent': ca.public_bytes(serialization.Encoding.DER)}]}
    (folder / 'ScrewShop.mobileconfig').write_bytes(plistlib.dumps(profile))
    (folder / 'fingerprint.txt').write_text(ca.fingerprint(hashes.SHA256()).hex(':'), encoding='utf-8')
    return folder
