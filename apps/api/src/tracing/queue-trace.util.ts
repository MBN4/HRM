import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Phase 5.4 — connects an API-side span to a WORKER-side span for a job
 * processed asynchronously, minutes or hours apart, in a completely
 * separate process. Auto-instrumentation (`init-tracing.ts`) gives every
 * HTTP/Redis call a span "for free," but a BullMQ job crossing the
 * api->worker process boundary is NOT automatically linked — there is no
 * shared HTTP/Redis call an instrumentation library can hook for that; the
 * trace context has to be carried explicitly inside the job's own payload,
 * the same way distributed tracing across an HTTP boundary carries it in
 * the `traceparent` HEADER (W3C Trace Context — the identical propagation
 * FORMAT `propagation.inject`/`.extract` already implement here, just
 * carried in `job.data` instead of a header).
 *
 * Wired into ONE representative flow — `NotificationsService.handleDomainEvent`
 * (producer, `injectTraceContext`) -> `NotificationProcessor.process`
 * (consumer, `runWithExtractedTraceContext`) — see
 * docs/conventions/observability-load.md for why this one flow, and the
 * honestly-scoped statement that the other 14 queues in this codebase get
 * automatic HTTP/DB/Redis spans (real value already) but not yet this
 * explicit producer/consumer LINK; apply this exact pair to any other
 * queue that needs it later.
 */
export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

/** Called from the PRODUCER, before `queue.add(...)`, to attach the current trace context onto the job's own data. */
export function injectTraceContext(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Called from the CONSUMER (`Processor.process(job)`), wrapping the actual
 * per-job work in a new span that's a CHILD of the producer's span
 * (extracted from `carrier`) even though it's running in a different
 * process, potentially long after the producer's own request already
 * returned a response — this is what "spans connect api -> worker" means
 * concretely: a trace viewer can show the enqueuing HTTP request and the
 * job that eventually processed it as one connected trace, not two
 * unrelated ones.
 */
export async function runWithExtractedTraceContext<T>(
  spanName: string,
  carrier: TraceCarrier | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const parentContext = carrier ? propagation.extract(context.active(), carrier) : context.active();
  const tracer = trace.getTracer('hrm-worker');
  return context.with(parentContext, () =>
    tracer.startActiveSpan(spanName, async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}
