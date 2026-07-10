import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { isVoiceNoteId } from "./voice-store.js";

export type VoiceControlAction = "ask" | "act" | "dismiss";

const PREFIX = "devbot:voice:";
const ACT_MODAL_PREFIX = "devbot:voice-modal:act:";

export interface VoiceControlOptions {
  canControl: boolean;
  safeMode: boolean;
}

export function voiceControlRow(voiceId: string, options: VoiceControlOptions): ActionRowBuilder<ButtonBuilder> {
  if (!isVoiceNoteId(voiceId)) {
    throw new Error("Voice note ID cannot be encoded in a Discord control.");
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    button("ask", voiceId, "Ask", ButtonStyle.Primary),
    button("act", voiceId, "Make change", ButtonStyle.Success).setDisabled(!options.canControl || options.safeMode),
    button("dismiss", voiceId, "Dismiss", ButtonStyle.Secondary)
  );
}

export function parseVoiceControl(customId: string): { action: VoiceControlAction; voiceId: string } | undefined {
  const match = /^devbot:voice:(ask|act|dismiss):(.+)$/i.exec(customId);
  if (!match?.[1] || !match[2] || !isVoiceNoteId(match[2])) {
    return undefined;
  }
  return { action: match[1] as VoiceControlAction, voiceId: match[2] };
}

function button(action: VoiceControlAction, voiceId: string, label: string, style: ButtonStyle): ButtonBuilder {
  return new ButtonBuilder().setCustomId(`${PREFIX}${action}:${voiceId}`).setLabel(label).setStyle(style);
}

export function voiceActModal(voiceId: string, transcript: string): ModalBuilder {
  if (!isVoiceNoteId(voiceId)) {
    throw new Error("Voice note ID cannot be encoded in a Discord modal.");
  }
  const input = new TextInputBuilder()
    .setCustomId("request")
    .setLabel("Confirm or edit the change request")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(2)
    .setMaxLength(4_000)
    .setRequired(true)
    .setValue(transcript.slice(0, 4_000));
  return new ModalBuilder()
    .setCustomId(`${ACT_MODAL_PREFIX}${voiceId}`)
    .setTitle("Make a project change")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function parseVoiceActModal(customId: string): { voiceId: string } | undefined {
  if (!customId.startsWith(ACT_MODAL_PREFIX)) {
    return undefined;
  }
  const voiceId = customId.slice(ACT_MODAL_PREFIX.length);
  return isVoiceNoteId(voiceId) ? { voiceId } : undefined;
}
