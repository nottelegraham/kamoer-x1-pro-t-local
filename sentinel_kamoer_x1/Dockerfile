ARG BUILD_FROM
FROM ${BUILD_FROM}
RUN apk add --no-cache python3 py3-pip py3-cryptography py3-yaml iputils iproute2 \
 && pip3 install --no-cache-dir --break-system-packages "paho-mqtt>=1.6,<3"
WORKDIR /app
COPY run.py kamoer_bridge.py kamoerx1.py ./
CMD ["python3", "-u", "/app/run.py"]
