# Acknowledgements

This project stands on prior work. Credit where due:

## ffirenmatana — Kamoer X2SR reverse engineering
The approach here was informed by ffirenmatana's teardown of the Kamoer X2SR:
the local-cloud-emulation strategy, the replayable fixed-timestamp MQTT trick,
and the legacy-RSA cipher analysis were all starting points.
- Reverse engineering / reference / HA package: https://github.com/ffirenmatana/kamoer
- Home Assistant add-on (local proxy): https://github.com/ffirenmatana/kamoer-x2sr-addon

That work targets the X2SR. The X1 Pro-T protocol, the local ALCS control path,
the command frame format, and all code in this repository were worked out
independently for the X1 Pro-T and reimplemented from scratch (no code was
copied from those repositories).

## Alibaba — iotkit-embedded (Living Link device SDK)
The authentication, AES framing, and provisioning password encryption were
derived from Alibaba's open device SDK, which the pump firmware is built on.
- https://github.com/aliyun/iotkit-embedded  (Apache-2.0)

Our implementation is an independent Python reimplementation referencing that
SDK; it does not bundle SDK code.
