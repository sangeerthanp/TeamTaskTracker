import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../environments/environment';

export interface Ticket {
  id: number;
  title: string;
  state: string;
  assignedTo: string;
  type: string;
  parentId: number | null;
  // Sprint name/date-range, e.g. "Aug 10 - Aug 21" (last segment of Azure
  // DevOps' Iteration Path).
  sprint: string | null;
  priority: number;
  createdDate: string | null;
  changedDate: string | null;
  dueDate: string | null;
  // Hours this ticket represents - a Task's Original Estimate, or a User
  // Story's Story Points x 8. 0 when Azure DevOps has no estimate at all
  // (hasEstimate distinguishes "0 hours" from "never estimated").
  estimatedHours: number;
  hasEstimate: boolean;
  // Hours actually logged so far (Azure DevOps' Completed Work field) - only
  // ever set on Tasks, since that's the only type Azure DevOps tracks
  // hours-worked on; backlog-level types have no such field.
  completedHours: number;
  hasCompletedHours: boolean;
  // True for a parent fetched purely to complete the hierarchy chain (e.g. a
  // Release above an Epic) - it wasn't part of the Active/team-scoped query
  // itself, so it's excluded from active-ticket counts and hour totals and
  // used only as structural context for nesting.
  isContextOnly: boolean;
  link: string;
}

export interface TicketsResponse {
  tickets: Ticket[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface TicketsQuery {
  page?: number;
  pageSize?: number | 'all';
  assignedTo?: string;
  state?: string;
  type?: string;
  search?: string;
  includeParentContext?: boolean;
}

export interface DashboardProject {
  id: string;
  name: string;
}

export interface DashboardConfig {
  teamMembers: string[];
  projects: DashboardProject[];
}

@Injectable({
  providedIn: 'root'
})
export class TicketService {
  constructor(private http: HttpClient) {}

  // The team roster and project list, driven entirely by the server's
  // TEAM_MEMBERS/PROJECTS_CONFIG env vars - nothing org-specific is
  // hardcoded in the frontend itself.
  getConfig(): Observable<DashboardConfig> {
    return this.http.get<DashboardConfig>(`${environment.apiUrl}/api/config`);
  }

  getTickets(projectId: string, query: TicketsQuery = {}): Observable<TicketsResponse> {
    const params: Record<string, string> = { project: projectId };
    if (query.page) params['page'] = String(query.page);
    if (query.pageSize) params['pageSize'] = String(query.pageSize);
    if (query.assignedTo && query.assignedTo !== 'All') params['assignedTo'] = query.assignedTo;
    if (query.state && query.state !== 'All') params['state'] = query.state;
    if (query.type && query.type !== 'All') params['type'] = query.type;
    if (query.search && query.search.trim()) params['search'] = query.search.trim();
    if (query.includeParentContext) params['includeParentContext'] = 'true';

    const search = new URLSearchParams(params).toString();
    return this.http.get<TicketsResponse>(`${environment.apiUrl}/api/tickets?${search}`);
  }
}
