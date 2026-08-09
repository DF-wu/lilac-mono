import { Panic, Result } from "better-result";

import type {
  SurfaceAdapter,
  SurfaceAdapterEventSource,
  SurfaceCacheBurstProvider,
  SurfaceOperationError,
  SurfaceOperationResult,
  SurfaceOutputResult,
  SurfaceOutputStream,
  StartOutputOpts,
} from "./adapter";
import { hasCacheBurstProvider, hasSurfaceGuildIdResolver } from "./adapter";
import type { AdapterEvent } from "./events";
import type { SurfaceRelayPolicy, SurfaceWorkflowProgressPort } from "./runtime-descriptor";
import type { MsgRef, RegisteredSurfacePlatform, SessionRef, SurfaceMessage } from "./types";
import type { BusToAdapterRelaySnapshot } from "./bridge/subscribe-from-bus";

export function signalSurfaceAdapterContractViolation(input: {
  readonly descriptorPlatform: RegisteredSurfacePlatform;
  readonly contract: string;
  readonly detail: string;
}): never {
  throw new Panic({
    message: `Surface adapter contract violation for '${input.descriptorPlatform}' at ${input.contract}: ${input.detail}`,
  });
}

function requirePlatform(input: {
  readonly descriptorPlatform: RegisteredSurfacePlatform;
  readonly contract: string;
  readonly producedPlatform: string;
}): void {
  if (input.producedPlatform === input.descriptorPlatform) return;
  signalSurfaceAdapterContractViolation({
    descriptorPlatform: input.descriptorPlatform,
    contract: input.contract,
    detail: `expected platform '${input.descriptorPlatform}', received '${input.producedPlatform}'`,
  });
}

export function requireDescriptorPlatform(
  descriptorPlatform: RegisteredSurfacePlatform,
  producedPlatform: string,
  contract: string,
): void {
  requirePlatform({ descriptorPlatform, producedPlatform, contract });
}

export function requireProducedSessionRef(
  descriptorPlatform: RegisteredSurfacePlatform,
  ref: SessionRef,
  contract: string,
  expectedSessionId?: string,
): void {
  requirePlatform({
    descriptorPlatform,
    contract,
    producedPlatform: ref.platform,
  });
  if (expectedSessionId === undefined || ref.channelId === expectedSessionId) return;
  signalSurfaceAdapterContractViolation({
    descriptorPlatform,
    contract,
    detail: `expected session '${expectedSessionId}', received '${ref.channelId}'`,
  });
}

export function requireProducedMsgRef(
  descriptorPlatform: RegisteredSurfacePlatform,
  ref: MsgRef,
  contract: string,
  expectedSessionId?: string,
): void {
  requirePlatform({
    descriptorPlatform,
    contract,
    producedPlatform: ref.platform,
  });
  if (expectedSessionId === undefined || ref.channelId === expectedSessionId) return;
  signalSurfaceAdapterContractViolation({
    descriptorPlatform,
    contract,
    detail: `expected session '${expectedSessionId}', received '${ref.channelId}'`,
  });
}

function requireProducedMessage(
  descriptorPlatform: RegisteredSurfacePlatform,
  message: SurfaceMessage,
  contract: string,
  expectedSessionId?: string,
): void {
  requireProducedMsgRef(descriptorPlatform, message.ref, `${contract}.ref`, expectedSessionId);
  requireProducedSessionRef(
    descriptorPlatform,
    message.session,
    `${contract}.session`,
    expectedSessionId,
  );
  if (message.ref.channelId === message.session.channelId) return;
  signalSurfaceAdapterContractViolation({
    descriptorPlatform,
    contract,
    detail: `message ref session '${message.ref.channelId}' disagrees with message session '${message.session.channelId}'`,
  });
}

function requireProducedMessages(
  descriptorPlatform: RegisteredSurfacePlatform,
  messages: readonly SurfaceMessage[],
  contract: string,
  expectedSessionId?: string,
): void {
  for (const [index, message] of messages.entries()) {
    requireProducedMessage(descriptorPlatform, message, `${contract}[${index}]`, expectedSessionId);
  }
}

function requireOperationError(
  descriptorPlatform: RegisteredSurfacePlatform,
  error: SurfaceOperationError,
  contract: string,
  expectedSessionId?: string,
): void {
  switch (error._tag) {
    case "SurfaceOperationUnsupported":
    case "SurfaceInvalidInput":
    case "SurfaceMessageNotFound":
    case "SurfacePermissionDenied":
    case "SurfaceRateLimited":
    case "SurfaceUnavailable":
      requirePlatform({
        descriptorPlatform,
        contract: `${contract}.error`,
        producedPlatform: error.platform,
      });
      return;
    case "SurfacePlatformMismatch":
      requirePlatform({
        descriptorPlatform,
        contract: `${contract}.error.expectedPlatform`,
        producedPlatform: error.expectedPlatform,
      });
      return;
    case "SurfaceSessionMismatch":
      return;
    case "SurfaceOperationPartiallyCompleted":
      requirePlatform({
        descriptorPlatform,
        contract: `${contract}.error`,
        producedPlatform: error.platform,
      });
      requireProducedMsgRef(
        descriptorPlatform,
        error.created,
        `${contract}.error.created`,
        expectedSessionId,
      );
      return;
  }
}

function requireOperationResult<T>(
  descriptorPlatform: RegisteredSurfacePlatform,
  result: SurfaceOperationResult<T>,
  contract: string,
  expectedSessionId?: string,
): void {
  if (result.status === "error") {
    requireOperationError(descriptorPlatform, result.error, contract, expectedSessionId);
  }
}

function guardOutputStream(
  descriptorPlatform: RegisteredSurfacePlatform,
  expectedSessionId: string,
  stream: SurfaceOutputStream,
): SurfaceOutputStream {
  const guarded: SurfaceOutputStream = {
    push: async (part) => {
      const pushed = await stream.push(part);
      requireOperationResult(
        descriptorPlatform,
        pushed,
        "startOutput.stream.push",
        expectedSessionId,
      );
      return pushed;
    },
    finish: async () => {
      const finished = await stream.finish();
      requireOperationResult(
        descriptorPlatform,
        finished,
        "startOutput.stream.finish",
        expectedSessionId,
      );
      if (finished.status === "ok") {
        requireSurfaceOutputResult(
          descriptorPlatform,
          expectedSessionId,
          finished.value,
          "startOutput.stream.finish",
        );
      }
      return finished;
    },
    abort: async (reason) => {
      const aborted = await stream.abort(reason);
      requireOperationResult(
        descriptorPlatform,
        aborted,
        "startOutput.stream.abort",
        expectedSessionId,
      );
      return aborted;
    },
  };
  if (stream.getFinalTextMode) {
    const getFinalTextMode = stream.getFinalTextMode.bind(stream);
    Object.defineProperty(guarded, "getFinalTextMode", {
      value: getFinalTextMode,
    });
  }
  return guarded;
}

function requireSurfaceOutputResult(
  descriptorPlatform: RegisteredSurfacePlatform,
  expectedSessionId: string,
  output: SurfaceOutputResult,
  contract: string,
): void {
  for (const [index, ref] of output.created.entries()) {
    requireProducedMsgRef(
      descriptorPlatform,
      ref,
      `${contract}.created[${index}]`,
      expectedSessionId,
    );
  }
  requireProducedMsgRef(descriptorPlatform, output.last, `${contract}.last`, expectedSessionId);
}

const GUARDED_ADAPTERS = new WeakMap<SurfaceAdapter, RegisteredSurfacePlatform>();

class DescriptorBoundSurfaceAdapter implements SurfaceAdapter {
  constructor(
    private readonly descriptorPlatform: RegisteredSurfacePlatform,
    private readonly adapter: SurfaceAdapter,
  ) {}

  async connect(): Promise<void> {
    await this.adapter.connect();
  }

  async disconnect(): Promise<void> {
    await this.adapter.disconnect();
  }

  async getSelf() {
    const self = await this.adapter.getSelf();
    requirePlatform({
      descriptorPlatform: this.descriptorPlatform,
      contract: "getSelf",
      producedPlatform: self.platform,
    });
    return self;
  }

  async listSessions() {
    const listed = await this.adapter.listSessions();
    requireOperationResult(this.descriptorPlatform, listed, "listSessions");
    if (listed.status === "ok") {
      for (const [index, session] of listed.value.entries()) {
        requireProducedSessionRef(
          this.descriptorPlatform,
          session.ref,
          `listSessions[${index}].ref`,
        );
      }
    }
    return listed;
  }

  async listSessionParticipants(sessionRef: SessionRef, opts?: { readonly limit?: number }) {
    const listed = await this.adapter.listSessionParticipants(sessionRef, opts);
    requireOperationResult(
      this.descriptorPlatform,
      listed,
      "listSessionParticipants",
      sessionRef.channelId,
    );
    return listed;
  }

  async startOutput(sessionRef: SessionRef, opts?: StartOutputOpts) {
    const guardedOpts = opts
      ? {
          ...opts,
          ...(opts.onMessageCreated
            ? {
                onMessageCreated: (ref: MsgRef) => {
                  requireProducedMsgRef(
                    this.descriptorPlatform,
                    ref,
                    "startOutput.onMessageCreated",
                    sessionRef.channelId,
                  );
                  opts.onMessageCreated?.(ref);
                },
              }
            : {}),
        }
      : undefined;
    const started = await this.adapter.startOutput(sessionRef, guardedOpts);
    requireOperationResult(this.descriptorPlatform, started, "startOutput", sessionRef.channelId);
    if (started.status === "error") return started;
    return Result.ok(
      guardOutputStream(this.descriptorPlatform, sessionRef.channelId, started.value),
    );
  }

  async startTyping(sessionRef: SessionRef) {
    const started = await this.adapter.startTyping(sessionRef);
    requireOperationResult(this.descriptorPlatform, started, "startTyping", sessionRef.channelId);
    if (started.status === "error") return started;
    return Result.ok({
      stop: async () => {
        const stopped = await started.value.stop();
        requireOperationResult(
          this.descriptorPlatform,
          stopped,
          "startTyping.stop",
          sessionRef.channelId,
        );
        return stopped;
      },
    });
  }

  async sendMsg(
    sessionRef: SessionRef,
    content: Parameters<SurfaceAdapter["sendMsg"]>[1],
    opts?: Parameters<SurfaceAdapter["sendMsg"]>[2],
  ) {
    const sent = await this.adapter.sendMsg(sessionRef, content, opts);
    requireOperationResult(this.descriptorPlatform, sent, "sendMsg", sessionRef.channelId);
    if (sent.status === "ok") {
      requireProducedMsgRef(
        this.descriptorPlatform,
        sent.value,
        "sendMsg.result",
        sessionRef.channelId,
      );
    }
    return sent;
  }

  async readMsg(msgRef: MsgRef) {
    const read = await this.adapter.readMsg(msgRef);
    requireOperationResult(this.descriptorPlatform, read, "readMsg", msgRef.channelId);
    if (read.status === "ok" && read.value) {
      requireProducedMessage(
        this.descriptorPlatform,
        read.value,
        "readMsg.result",
        msgRef.channelId,
      );
    }
    return read;
  }

  async listMsg(sessionRef: SessionRef, opts?: Parameters<SurfaceAdapter["listMsg"]>[1]) {
    const listed = await this.adapter.listMsg(sessionRef, opts);
    requireOperationResult(this.descriptorPlatform, listed, "listMsg", sessionRef.channelId);
    if (listed.status === "ok") {
      requireProducedMessages(
        this.descriptorPlatform,
        listed.value,
        "listMsg.result",
        sessionRef.channelId,
      );
    }
    return listed;
  }

  async editMsg(msgRef: MsgRef, content: Parameters<SurfaceAdapter["editMsg"]>[1]) {
    const edited = await this.adapter.editMsg(msgRef, content);
    requireOperationResult(this.descriptorPlatform, edited, "editMsg", msgRef.channelId);
    return edited;
  }

  async deleteMsg(msgRef: MsgRef) {
    const deleted = await this.adapter.deleteMsg(msgRef);
    requireOperationResult(this.descriptorPlatform, deleted, "deleteMsg", msgRef.channelId);
    return deleted;
  }

  async getReplyContext(msgRef: MsgRef, opts?: Parameters<SurfaceAdapter["getReplyContext"]>[1]) {
    const context = await this.adapter.getReplyContext(msgRef, opts);
    requireOperationResult(this.descriptorPlatform, context, "getReplyContext", msgRef.channelId);
    if (context.status === "ok") {
      requireProducedMessages(
        this.descriptorPlatform,
        context.value,
        "getReplyContext.result",
        msgRef.channelId,
      );
    }
    return context;
  }

  async planReplyChain(msgRef: MsgRef, opts?: Parameters<SurfaceAdapter["planReplyChain"]>[1]) {
    const planned = await this.adapter.planReplyChain(msgRef, opts);
    requireOperationResult(this.descriptorPlatform, planned, "planReplyChain", msgRef.channelId);
    if (planned.status === "ok") {
      for (const [index, ref] of planned.value.entries()) {
        requireProducedMsgRef(
          this.descriptorPlatform,
          ref,
          `planReplyChain.result[${index}]`,
          msgRef.channelId,
        );
      }
    }
    return planned;
  }

  async planMergeBlockEndingAt(
    msgRef: MsgRef,
    opts?: Parameters<SurfaceAdapter["planMergeBlockEndingAt"]>[1],
  ) {
    const planned = await this.adapter.planMergeBlockEndingAt(msgRef, opts);
    requireOperationResult(
      this.descriptorPlatform,
      planned,
      "planMergeBlockEndingAt",
      msgRef.channelId,
    );
    if (planned.status === "ok") {
      for (const [index, ref] of planned.value.entries()) {
        requireProducedMsgRef(
          this.descriptorPlatform,
          ref,
          `planMergeBlockEndingAt.result[${index}]`,
          msgRef.channelId,
        );
      }
    }
    return planned;
  }

  async addReaction(msgRef: MsgRef, reaction: string) {
    const added = await this.adapter.addReaction(msgRef, reaction);
    requireOperationResult(this.descriptorPlatform, added, "addReaction", msgRef.channelId);
    return added;
  }

  async removeReaction(msgRef: MsgRef, reaction: string) {
    const removed = await this.adapter.removeReaction(msgRef, reaction);
    requireOperationResult(this.descriptorPlatform, removed, "removeReaction", msgRef.channelId);
    return removed;
  }

  async listReactions(msgRef: MsgRef) {
    const listed = await this.adapter.listReactions(msgRef);
    requireOperationResult(this.descriptorPlatform, listed, "listReactions", msgRef.channelId);
    return listed;
  }

  async listReactionDetails(msgRef: MsgRef) {
    const listed = await this.adapter.listReactionDetails(msgRef);
    requireOperationResult(
      this.descriptorPlatform,
      listed,
      "listReactionDetails",
      msgRef.channelId,
    );
    return listed;
  }

  async getUnRead(sessionRef: SessionRef) {
    const unread = await this.adapter.getUnRead(sessionRef);
    requireOperationResult(this.descriptorPlatform, unread, "getUnRead", sessionRef.channelId);
    if (unread.status === "ok") {
      requireProducedMessages(
        this.descriptorPlatform,
        unread.value,
        "getUnRead.result",
        sessionRef.channelId,
      );
    }
    return unread;
  }

  async markRead(sessionRef: SessionRef, upToMsgRef?: MsgRef) {
    const marked = await this.adapter.markRead(sessionRef, upToMsgRef);
    requireOperationResult(this.descriptorPlatform, marked, "markRead", sessionRef.channelId);
    return marked;
  }
}

export function createDescriptorBoundSurfaceAdapter(
  descriptorPlatform: RegisteredSurfacePlatform,
  adapter: SurfaceAdapter,
): SurfaceAdapter {
  if (GUARDED_ADAPTERS.get(adapter) === descriptorPlatform) return adapter;
  const guarded = new DescriptorBoundSurfaceAdapter(descriptorPlatform, adapter);
  if (hasCacheBurstProvider(adapter)) {
    Object.defineProperty(guarded, "burstCache", {
      value: (input: Parameters<SurfaceCacheBurstProvider["burstCache"]>[0]) =>
        adapter.burstCache(input),
    });
  }
  if (hasSurfaceGuildIdResolver(adapter)) {
    Object.defineProperty(guarded, "fetchGuildIdForChannel", {
      value: (channelId: string) => adapter.fetchGuildIdForChannel(channelId),
    });
  }
  GUARDED_ADAPTERS.set(guarded, descriptorPlatform);
  return guarded;
}

export function requireDescriptorBoundAdapterEvent(
  descriptorPlatform: RegisteredSurfacePlatform,
  event: AdapterEvent,
): void {
  requirePlatform({
    descriptorPlatform,
    contract: `${event.type}.platform`,
    producedPlatform: event.platform,
  });
  switch (event.type) {
    case "adapter.message.created":
    case "adapter.message.updated":
      requireProducedMessage(
        descriptorPlatform,
        event.message,
        event.type,
        event.message.session.channelId,
      );
      return;
    case "adapter.message.deleted":
    case "adapter.reaction.added":
    case "adapter.reaction.removed":
      requireProducedSessionRef(descriptorPlatform, event.session, `${event.type}.session`);
      requireProducedMsgRef(
        descriptorPlatform,
        event.messageRef,
        `${event.type}.messageRef`,
        event.session.channelId,
      );
      return;
    case "adapter.action.invoked":
      requireProducedMsgRef(descriptorPlatform, event.messageRef, `${event.type}.messageRef`);
      return;
    case "adapter.request.cancel":
    case "adapter.command.invoked":
      return;
  }
}

export function createDescriptorBoundSurfaceEventSource(
  descriptorPlatform: RegisteredSurfacePlatform,
  eventSource: SurfaceAdapterEventSource,
): SurfaceAdapterEventSource {
  return {
    subscribe: (handler) =>
      eventSource.subscribe((event) => {
        requireDescriptorBoundAdapterEvent(descriptorPlatform, event);
        return handler(event);
      }),
  };
}

const GUARDED_WORKFLOW_PORTS = new WeakMap<object, RegisteredSurfacePlatform>();

export function createDescriptorBoundWorkflowProgressPort<P extends RegisteredSurfacePlatform>(
  descriptorPlatform: P,
  port: SurfaceWorkflowProgressPort<P>,
): SurfaceWorkflowProgressPort<P> {
  if (GUARDED_WORKFLOW_PORTS.get(port) === descriptorPlatform) return port;
  const guarded: SurfaceWorkflowProgressPort<P> = {
    checkMessage: (target) => port.checkMessage(target),
    send: async (input) => {
      const sent = await port.send(input);
      if (sent.status === "ok") {
        requireProducedMsgRef(
          descriptorPlatform,
          sent.value,
          "workflowProgress.send.result",
          input.channelId,
        );
      } else if (sent.error.kind === "created") {
        requireProducedMsgRef(
          descriptorPlatform,
          sent.error.ref,
          "workflowProgress.send.error.created",
          input.channelId,
        );
      }
      return sent;
    },
    edit: (target, content) => port.edit(target, content),
  };
  GUARDED_WORKFLOW_PORTS.set(guarded, descriptorPlatform);
  return guarded;
}

export function requireSurfaceRelayPolicyRefs<P extends RegisteredSurfacePlatform>(
  descriptorPlatform: P,
  policy: SurfaceRelayPolicy<P>,
): SurfaceRelayPolicy<P> {
  return {
    refs: {
      createSessionRef: (sessionId) => {
        const ref = policy.refs.createSessionRef(sessionId);
        requireProducedSessionRef(
          descriptorPlatform,
          ref,
          "relay.refs.createSessionRef",
          sessionId,
        );
        return ref;
      },
      resolveInitialReplyTarget: (input) => {
        const resolved = policy.refs.resolveInitialReplyTarget(input);
        if (resolved.kind === "target") {
          requireProducedMsgRef(
            descriptorPlatform,
            resolved.ref,
            "relay.refs.resolveInitialReplyTarget",
            input.sessionId,
          );
        }
        return resolved;
      },
      decodeReanchorTarget: (input) => {
        const decoded = policy.refs.decodeReanchorTarget(input);
        if (decoded.status === "ok") {
          requireProducedMsgRef(
            descriptorPlatform,
            decoded.value,
            "relay.refs.decodeReanchorTarget",
            input.expectedSessionId,
          );
        }
        return decoded;
      },
    },
    ...(policy.finalization ? { finalization: policy.finalization } : {}),
  };
}

export function requireSurfaceRelaySnapshot(
  descriptorPlatform: RegisteredSurfacePlatform,
  snapshot: BusToAdapterRelaySnapshot,
  contract: string,
): void {
  requirePlatform({
    descriptorPlatform,
    contract: `${contract}.platform`,
    producedPlatform: snapshot.platform,
  });
  for (const [index, ref] of snapshot.createdOutputRefs.entries()) {
    requireProducedMsgRef(
      descriptorPlatform,
      ref,
      `${contract}.createdOutputRefs[${index}]`,
      snapshot.sessionId,
    );
  }
  for (const [index, ref] of (snapshot.activeOutputRefs ?? []).entries()) {
    requireProducedMsgRef(
      descriptorPlatform,
      ref,
      `${contract}.activeOutputRefs[${index}]`,
      snapshot.sessionId,
    );
  }
}
