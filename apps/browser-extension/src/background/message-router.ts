import type { StudyCaptureContext } from "./study-context.js";
import type { StudyMode } from "@qb-study/contracts";

import {
  GET_TAB_CONSENT_STATUS_MESSAGE_KIND,
  SET_TAB_CONSENT_MESSAGE_KIND,
  SET_STUDY_MODE_MESSAGE_KIND,
  STOP_TAB_CAPTURE_MESSAGE_KIND,
  isQbPageRouteMessageV1,
  START_STUDY_CAPTURE_MESSAGE_KIND,
  isAttemptCandidateMessageV1,
  isCaptureStatusMessageV1,
  isPopupRequestMessageV1,
  isQbQuizBootstrapReadyMessageV1,
  isQbQuizCaptureMessageV1,
  type CommandResponseV1,
  type TabConsentStatusV1,
  type StudyRouteEvidence,
} from "../shared/protocol.js";
import type {
  ConsentCommandResponse,
  ConsentSenderContext,
  ConsentTabStatusV1,
} from "./consent-controller.js";

export interface BackgroundCoreRouterPort {
  handleMessage(message: unknown, studyMode?: StudyMode, reviewPlanId?: string): Promise<unknown>;
}

export interface ConsentRouterPort {
  setStudyMode?(tabId: number, pageSessionId: string, mode: "normal" | "review"): Promise<ConsentCommandResponse>;
  handlePageRoute?(sender: ConsentSenderContext, contextLost?: boolean, evidence?: StudyRouteEvidence): Promise<CommandResponseV1>;
  stopCapture?(tabId: number, pageSessionId: string): Promise<ConsentCommandResponse>;
  getAcceptedCandidateContext?(sender: ConsentSenderContext): Promise<StudyCaptureContext | null>;
  getSenderStudyContext?(sender: ConsentSenderContext): Promise<StudyCaptureContext | null>;
  handleReady(input: {
    readonly page_session_id: string;
    readonly sender: ConsentSenderContext;
  }): Promise<ConsentCommandResponse>;
  getTabStatus(tabId: number): Promise<ConsentTabStatusV1 | null>;
  declineCapture(
    tabId: number,
    pageSessionId: string,
  ): Promise<ConsentCommandResponse>;
  startCapture(
    tabId: number,
    pageSessionId: string,
    studyMode?: StudyMode,
  ): Promise<ConsentCommandResponse>;
  getSenderStudyMode(sender: ConsentSenderContext): Promise<StudyMode | null>;
}

export interface BackgroundRouteSender {
  readonly consent_context: ConsentSenderContext | null;
  readonly extension_page: boolean;
}

function commandResponse(ok: boolean, code: string): CommandResponseV1 {
  return ok ? { ok: true, code } : { ok: false, code };
}

function popupConsentStatus(
  status: ConsentTabStatusV1 | null,
): TabConsentStatusV1 {
  if (status === null) {
    return { state: "unavailable", page_session_id: null };
  }
  if (status.capture_state === "paused") {
    return { state: "paused", page_session_id: status.page_session_id,
      ...(status.study_mode === undefined ? {} : { study_mode: status.study_mode }) };
  }
  if (status.decision === "declined") {
    return { state: "declined", page_session_id: status.page_session_id };
  }
  if (
    status.decision === "consented"
    && status.capture_state === "observing"
  ) {
    return { state: "capturing", page_session_id: status.page_session_id,
      ...(status.study_mode === undefined ? {} : { study_mode: status.study_mode }),
    };
  }
  return { state: "pending", page_session_id: status.page_session_id,
    ...(status.decision === "consented" && status.study_mode !== undefined
      ? { study_mode: status.study_mode } : {}),
  };
}

export class BackgroundMessageRouter {
  readonly #core: BackgroundCoreRouterPort;
  readonly #consent: ConsentRouterPort;

  public constructor(
    core: BackgroundCoreRouterPort,
    consent: ConsentRouterPort,
  ) {
    this.#core = core;
    this.#consent = consent;
  }

  public async handleMessage(
    message: unknown,
    sender: BackgroundRouteSender,
  ): Promise<unknown> {
    if (isQbPageRouteMessageV1(message)) {
      if (sender.consent_context === null || this.#consent.handlePageRoute === undefined) {
        return commandResponse(false, "study_route_unavailable");
      }
      return await this.#consent.handlePageRoute(sender.consent_context, message.context_lost, message);
    }
    if (isQbQuizBootstrapReadyMessageV1(message)) {
      if (sender.consent_context === null) {
        return commandResponse(false, "consent_ready_rejected");
      }
      return await this.#consent.handleReady({
        page_session_id: message.page_session_id,
        sender: sender.consent_context,
      });
    }

    if (isQbQuizCaptureMessageV1(message)) {
      if (sender.consent_context === null) {
        return commandResponse(false, "capture_consent_required");
      }
      const consentContext: ConsentSenderContext = {
        ...sender.consent_context,
        page_session_id: message.page_session_id,
      };
      const context = isAttemptCandidateMessageV1(message.message)
        && this.#consent.getAcceptedCandidateContext !== undefined
        ? await this.#consent.getAcceptedCandidateContext(consentContext)
        : this.#consent.getSenderStudyContext === undefined
          ? await this.#consent.getSenderStudyMode(consentContext).then(
            (study_mode) => study_mode === null ? null : { study_mode },
          )
          : await this.#consent.getSenderStudyContext(consentContext);
      if (context === null) {
        return commandResponse(false, "capture_consent_required");
      }
      return "review_plan_id" in context && context.review_plan_id !== undefined
        ? await this.#core.handleMessage(message.message, context.study_mode, context.review_plan_id)
        : await this.#core.handleMessage(message.message, context.study_mode);
    }

    if (isAttemptCandidateMessageV1(message) || isCaptureStatusMessageV1(message)) {
      return commandResponse(false, "capture_consent_required");
    }

    if (isPopupRequestMessageV1(message)) {
      if (!sender.extension_page) {
        return commandResponse(false, "popup_sender_rejected");
      }
      if (message.kind === GET_TAB_CONSENT_STATUS_MESSAGE_KIND) {
        return popupConsentStatus(await this.#consent.getTabStatus(message.tab_id));
      }
      if (message.kind === SET_STUDY_MODE_MESSAGE_KIND) {
        return this.#consent.setStudyMode === undefined
          ? commandResponse(false, "study_mode_change_blocked")
          : await this.#consent.setStudyMode(message.tab_id, message.page_session_id, message.study_mode);
      }
      if (message.kind === STOP_TAB_CAPTURE_MESSAGE_KIND) {
        return this.#consent.stopCapture === undefined
          ? commandResponse(false, "capture_stop_unavailable")
          : await this.#consent.stopCapture(message.tab_id, message.page_session_id);
      }
      if (message.kind === START_STUDY_CAPTURE_MESSAGE_KIND) {
        return await this.#consent.startCapture(message.tab_id, message.page_session_id, message.study_mode);
      }
      if (message.kind === SET_TAB_CONSENT_MESSAGE_KIND) {
        return message.decision === "start"
          ? await this.#consent.startCapture(message.tab_id, message.page_session_id)
          : await this.#consent.declineCapture(message.tab_id, message.page_session_id);
      }
      return await this.#core.handleMessage(message);
    }

    return sender.extension_page
      ? await this.#core.handleMessage(message)
      : commandResponse(false, "background_message_rejected");
  }
}
