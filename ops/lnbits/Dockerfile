# Scheduled LNbits recycle without access to the Docker socket.
# Build context: ./ops/lnbits (see docker-compose lnbits service).
# Upstream v1.7.1 has no ENTRYPOINT. Its CMD is restated below because
# setting an ENTRYPOINT clears the parent CMD. `--no-sync` is a flag of
# `uv run` (the offline image must not try to sync dependencies).
#
# The tag is not digest-pinned. v1.7.1 publishes separate platform manifests
# (linux/amd64 sha256:f26fc63d… and linux/arm64 sha256:75d9e6f2…). The deploy
# host architecture is not recorded in this repo; pinning only the amd64
# digest would break a build on an arm64 host.

ARG LNBITS_IMAGE=lnbits/lnbits:v1.7.1
FROM ${LNBITS_IMAGE}

COPY lnbits-restart-entrypoint.py /usr/local/bin/lnbits-restart-entrypoint.py

ENTRYPOINT ["python", "-u", "/usr/local/bin/lnbits-restart-entrypoint.py"]
CMD ["sh", "-c", "uv --offline run --no-sync lnbits --port $LNBITS_PORT --host $LNBITS_HOST --forwarded-allow-ips='*'"]
