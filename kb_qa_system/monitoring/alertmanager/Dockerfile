FROM prom/alertmanager:v0.28.1 AS alertmanager

FROM alpine:3.21
RUN apk add --no-cache ca-certificates python3 \
    && addgroup -S -g 10001 alertmanager \
    && adduser -S -D -H -u 10001 -G alertmanager alertmanager \
    && mkdir -p /alertmanager \
    && chown alertmanager:alertmanager /alertmanager
COPY --from=alertmanager /bin/alertmanager /usr/local/bin/alertmanager
COPY alertmanager/render_config.py /usr/local/bin/render-alertmanager-config
COPY alertmanager/entrypoint.sh /usr/local/bin/alertmanager-entrypoint
RUN chmod 0555 /usr/local/bin/render-alertmanager-config /usr/local/bin/alertmanager-entrypoint
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/alertmanager-entrypoint"]
