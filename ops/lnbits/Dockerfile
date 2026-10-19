# Scheduled LNbits recycle without access to the Docker socket.
# Build context: ./ops/lnbits (see docker-compose lnbits service).
# The pinned base image's command, port, workdir, and env are unchanged.
# Upstream v1.5.6 has no ENTRYPOINT; its CMD is restated below because
# setting an ENTRYPOINT clears the parent CMD.

ARG LNBITS_IMAGE=lnbits/lnbits:v1.5.6
FROM ${LNBITS_IMAGE}

COPY lnbits-restart-entrypoint.py /usr/local/bin/lnbits-restart-entrypoint.py

ENTRYPOINT ["python", "-u", "/usr/local/bin/lnbits-restart-entrypoint.py"]
CMD ["sh", "-c", "uv --offline run lnbits --port $LNBITS_PORT --host $LNBITS_HOST --forwarded-allow-ips='*'"]
