// Stand-in for the Workers runtime modules so Think's messenger serializer,
// which is plain code, can load under Node.
export class DurableObject {}
export class RpcTarget {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
export class WorkflowEvent {}
export class EmailMessage {}
export const env = {};
export const exports = {};
