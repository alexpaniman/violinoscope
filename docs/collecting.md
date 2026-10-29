# Collecting traces

Violinoscope reads recorded spans; it does not instrument or query your application. A local process and a cluster use the same input formats. Instrument the operation you want to compare, retain its children and links, then export complete traces. A generic SDK cannot reveal internal compiler phases unless the application records them.

## Local trial

You can try the report without a running service:

```sh
python3 tests/synth.py /tmp/before.jsonl --group before --traces 200
python3 tests/synth.py /tmp/after.jsonl --group after --traces 200 --seed 2
python3 violinoscope.py /tmp/before.jsonl /tmp/after.jsonl --unit "Handle request"
```

For a real workload, use the application's existing OTLP exporter or export individual span objects as protobuf JSON. Choose a root span that occurs once per request. Put a run name in the resource attribute `dataset.name`, or use `name=path` on the converter command line. Use `--label-attr job.name` to label units from a span attribute; `--skip-label warmup` filters that value. This works even when query text is absent or redacted.

## OpenTelemetry Collector

An OTLP receiver plus a file exporter is the shortest route from an instrumented application to an input file. The Collector's file exporter writes newline-delimited OTLP JSON when `format: json` is used without compression or an encoding extension. See the [official file exporter documentation](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/fileexporter/README.md).

Save this as `collector.yaml` and run `otelcol-contrib --config collector.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 127.0.0.1:4317
      http:
        endpoint: 127.0.0.1:4318
exporters:
  file:
    path: ./spans.jsonl
    format: json
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file]
```

Point your application's exporter at that receiver, run the workload, flush its SDK exporter, and stop the Collector gracefully before copying the file. Applications using standard SDK environment configuration can use `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL` and `OTEL_RESOURCE_ATTRIBUTES`; other applications may expose their own settings. See [SDK exporter configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/) and [resource configuration](https://opentelemetry.io/docs/languages/sdk-configuration/general/).

```sh
python3 violinoscope.py local=spans.jsonl --unit "Handle request" -o local.html
```

In a cluster, run this pipeline in a Collector sidecar, agent or gateway with a writable mounted directory. Bind the receiver to a pod-reachable interface and use your deployment's normal TLS/authentication configuration. You can add the file exporter to an existing trace pipeline while keeping its backend exporter. Copy the resulting JSON files locally and pass them together to the converter. Collector pipelines explicitly list both receivers and exporters; see [Collector configuration](https://opentelemetry.io/docs/collector/configuration/).

Use the same sampling policy across compared runs. Sampling, missing children, truncated exports and clock skew affect the measurements; a report cannot recover spans that were never recorded. Query text is not embedded by default, but traces and span names may still contain application data.

## Jaeger

Export JSON from the trace UI, save responses from its query API, or fetch directly:

```sh
python3 violinoscope.py --jaeger http://localhost:16686 --service my-service \
  --lookback 3600 --limit 5000 --unit "Handle request" -o requests.html
```

The lookback is in seconds. The converter warns when it reaches the result limit; narrow the window or increase the limit for a complete collection. For authenticated deployments, export with your usual authenticated client and pass the saved JSON file.

Jaeger's UI HTTP JSON API is internal and can change. A trace-by-ID response is available at `/api/traces/TRACE_ID`; see [Jaeger's API documentation](https://www.jaegertracing.io/docs/2.22/architecture/apis/). Parent references and `FOLLOWS_FROM` are read, but an export may not preserve every original OTLP link attribute. Collector file exports preserve the optional flow metadata more directly.

## Grafana Tempo and other backends

Tempo offers trace-by-ID JSON from its query frontend:

```sh
curl -fsS -H 'Accept: application/json' \
  http://localhost:3200/api/traces/TRACE_ID > trace.json
python3 violinoscope.py trace.json --unit "Handle request"
```

Supply your deployment's tenant/authentication headers when required. The converter accepts the OTLP resource shape, Tempo's `batches` shape, and a v2 response's `trace` wrapper. Search result summaries are not complete traces: fetch each selected trace ID before converting. See [Tempo's HTTP API](https://grafana.com/docs/tempo/latest/api_docs/).

Any backend that exports full OTLP JSON can feed the same converter. Other proprietary JSON formats need conversion first. Raw binary OTLP, Jaeger storage databases and Collector zstd streams are not direct inputs; export uncompressed JSON or decompress to it.
