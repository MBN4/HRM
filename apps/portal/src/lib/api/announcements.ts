import { apiFetch } from './client';
import type { Announcement, Policy, PolicyAcknowledgment } from './types';

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  targetBranchIds?: string[];
  targetDepartmentIds?: string[];
  publish?: boolean;
}

export function createAnnouncement(input: CreateAnnouncementInput): Promise<Announcement> {
  return apiFetch<Announcement>('/announcements', { method: 'POST', body: input });
}

export function publishAnnouncement(id: string): Promise<Announcement> {
  return apiFetch<Announcement>(`/announcements/${id}/publish`, { method: 'POST' });
}

export function deactivateAnnouncement(id: string): Promise<Announcement> {
  return apiFetch<Announcement>(`/announcements/${id}/deactivate`, { method: 'POST' });
}

export function listAllAnnouncements(): Promise<Announcement[]> {
  return apiFetch<Announcement[]>('/announcements/admin');
}

export function listMyAnnouncements(): Promise<Announcement[]> {
  return apiFetch<Announcement[]>('/announcements');
}

export interface CreatePolicyInput {
  title: string;
  body: string;
  requiresAcknowledgment?: boolean;
  publish?: boolean;
}

export function createPolicy(input: CreatePolicyInput): Promise<Policy> {
  return apiFetch<Policy>('/policies', { method: 'POST', body: input });
}

export function publishPolicy(id: string): Promise<Policy> {
  return apiFetch<Policy>(`/policies/${id}/publish`, { method: 'POST' });
}

export function listAllPolicies(): Promise<Policy[]> {
  return apiFetch<Policy[]>('/policies/admin');
}

export function listActivePolicies(): Promise<Policy[]> {
  return apiFetch<Policy[]>('/policies');
}

export function acknowledgePolicy(id: string): Promise<PolicyAcknowledgment> {
  return apiFetch<PolicyAcknowledgment>(`/policies/${id}/acknowledge`, { method: 'POST' });
}

export function listPolicyAcknowledgments(id: string): Promise<PolicyAcknowledgment[]> {
  return apiFetch<PolicyAcknowledgment[]>(`/policies/${id}/acknowledgments`);
}

export function myPolicyAcknowledgments(): Promise<PolicyAcknowledgment[]> {
  return apiFetch<PolicyAcknowledgment[]>('/policies/my-acknowledgments');
}
