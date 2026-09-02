import { apiFetch, apiFetchBlob } from './client';
import { triggerBrowserDownload } from '../download';
import type { Ticket, TicketAttachment, TicketCategory, TicketComment, TicketPriority, TicketStatus } from './types';

export interface CreateTicketCategoryInput {
  code: string;
  name: string;
  defaultSlaMinutes?: number;
}

export function upsertTicketCategory(input: CreateTicketCategoryInput): Promise<TicketCategory> {
  return apiFetch<TicketCategory>('/helpdesk/categories', { method: 'POST', body: input });
}

export function listTicketCategories(): Promise<TicketCategory[]> {
  return apiFetch<TicketCategory[]>('/helpdesk/categories');
}

export function createTicket(input: { categoryId: string; subject: string; description: string; priority?: TicketPriority }): Promise<Ticket> {
  return apiFetch<Ticket>('/helpdesk/tickets', { method: 'POST', body: input });
}

export function listTickets(params: { status?: string; assignedToUserId?: string } = {}): Promise<Ticket[]> {
  return apiFetch<Ticket[]>('/helpdesk/tickets', { query: params });
}

export function getTicket(id: string): Promise<Ticket> {
  return apiFetch<Ticket>(`/helpdesk/tickets/${id}`);
}

export function addTicketComment(ticketId: string, body: string): Promise<TicketComment> {
  return apiFetch<TicketComment>(`/helpdesk/tickets/${ticketId}/comments`, { method: 'POST', body: { body } });
}

export function listTicketComments(ticketId: string): Promise<TicketComment[]> {
  return apiFetch<TicketComment[]>(`/helpdesk/tickets/${ticketId}/comments`);
}

export async function addTicketAttachment(ticketId: string, file: File): Promise<TicketAttachment> {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch<TicketAttachment>(`/helpdesk/tickets/${ticketId}/attachments`, { method: 'POST', body: formData });
}

export function listTicketAttachments(ticketId: string): Promise<TicketAttachment[]> {
  return apiFetch<TicketAttachment[]>(`/helpdesk/tickets/${ticketId}/attachments`);
}

export async function downloadTicketAttachment(ticketId: string, attachmentId: string, filename: string): Promise<void> {
  const { blob } = await apiFetchBlob(`/helpdesk/tickets/${ticketId}/attachments/${attachmentId}`);
  triggerBrowserDownload(blob, filename);
}

export function assignTicket(ticketId: string, assignedToUserId: string): Promise<Ticket> {
  return apiFetch<Ticket>(`/helpdesk/tickets/${ticketId}/assign`, { method: 'POST', body: { assignedToUserId } });
}

export function updateTicketStatus(ticketId: string, status: TicketStatus): Promise<Ticket> {
  return apiFetch<Ticket>(`/helpdesk/tickets/${ticketId}/status`, { method: 'POST', body: { status } });
}
