import { z } from 'zod';

const severitySchema = z.enum(['Critical', 'High', 'Info', 'Low', 'Medium']);

export const findingSchema = z
  .object({
    cwe: z.string().min(1),
    cvss_v31_score: z.number().min(0).max(10),
    cvss_v31_vector: z.string().min(1),
    cvss_v40_score: z.number().min(0).max(10).nullable().optional(),
    file_paths: z.array(z.string().min(1)).min(1),
    severity_label: severitySchema,
    title: z.string().min(1),
    vuln_id: z.string().min(1),
  })
  .strict();

export const securityReportSchema = z
  .object({
    findings: z.array(findingSchema),
  })
  .strict();

export type SecurityFinding = z.infer<typeof findingSchema>;
export type SecurityReport = z.infer<typeof securityReportSchema>;
