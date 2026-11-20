#!/bin/sh
# Create a certificate authority and a certificate for localhost on first
# start, then start the stubs. The broker trusts the authority through
# NODE_EXTRA_CA_CERTS, so it can fetch the Client ID Document over HTTPS.
# The keys stay in the sandbox's own volume.
set -eu

certs="${SANDBOX_CERTS_DIR:-/certs}"
if [ ! -f "${certs}/cert.pem" ]; then
  cd "${certs}"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -noenc \
    -days 365 -subj "/CN=solid-oidc sandbox CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
    -keyout ca-key.pem -out ca.pem 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -noenc \
    -subj "/CN=localhost" -keyout key.pem -out cert.csr 2>/dev/null
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > cert.ext
  openssl x509 -req -in cert.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
    -days 365 -extfile cert.ext -out cert.pem 2>/dev/null
  rm -f cert.csr cert.ext ca.srl ca-key.pem
  chmod 600 key.pem
  chmod 644 ca.pem cert.pem
  echo "Created a certificate for localhost in ${certs}"
fi

exec node /app/sandbox/stubs.ts
