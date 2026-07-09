/** TODO(wave-2): prepared script extracts metadata from incoming data */
export type InspectionResult = {
  readonly modality?: string;
  readonly bodyPart?: string;
  readonly species?: string;
  readonly resolutionUm?: number;
  readonly sliceCount?: number;
  readonly raw: Record<string, unknown>;
};

export async function inspectInput(
  _inputPath: string,
  _inspectScript?: string,
): Promise<InspectionResult> {
  // TODO(wave-2)
  return { raw: {} };
}
