export interface TranscriptSegment {
  readonly id: string;
  readonly recordingId: string;
  readonly speakerUserId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly rawText: string;
  readonly language: string;
}

