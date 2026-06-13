export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ClassifiedIncident {
  id: string;
  severity: Severity;
  service: string;
  description: string;
}
