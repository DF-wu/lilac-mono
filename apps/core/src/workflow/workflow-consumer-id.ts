export function workflowConsumerId(subscriptionId: string): string {
  return `${subscriptionId}:${process.pid}:${crypto.randomUUID()}`;
}
