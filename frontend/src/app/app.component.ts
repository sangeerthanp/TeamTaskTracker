import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { forkJoin } from 'rxjs';
import { Ticket, TicketService } from './ticket.service';

const HOURS_PER_DAY = 8;
const HOURS_PER_STORY_POINT = 8;
// Capacity window used only to size the workload bar visually - a full bar
// means "a week or more of remaining work queued up".
const WORKLOAD_BAR_CAP_HOURS = 40;

// A ticket in a member's list, with any children (per Azure DevOps' real
// Epic > Feature > Story/Bug > Task hierarchy - as deep as it actually goes
// for that ticket) nested underneath purely for display - see
// buildTicketTree for why their hours aren't summed into the parent.
export interface TicketNode {
  ticket: Ticket;
  children: TicketNode[];
}

export interface MemberWorkload {
  name: string;
  status: 'free' | 'engaged' | 'unestimated';
  // What's actually driving the "engaged" verdict - logged hours are the most
  // precise signal, a future due date is the next best thing, and an overdue
  // ticket still counts as engaged (they're presumably still on it) but with
  // no reliable free date to project.
  engagementBasis: 'hours' | 'dueDate' | 'overdue' | null;
  activeCount: number;
  totalHours: number;
  daysNeeded: number;
  freeDate: Date | null;
  workloadPercent: number;
  tickets: Ticket[];
  groups: TicketNode[];
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {
  // Bound to the Tickets tab's scrollable table body - reset to top on page
  // change so the next/previous page doesn't open at whatever scroll depth
  // the previous page was left at.
  @ViewChild('tableWrap') private tableWrapRef?: ElementRef<HTMLDivElement>;

  // Current page of tickets for the Tickets tab (fetched from the server one page at a time).
  tickets: Ticket[] = [];
  // Full team-scoped ticket set, used only for the Summary tab's totals and charts.
  allTickets: Ticket[] = [];
  loading = true;
  errorMessage = '';
  searchTerm = '';
  assigneeFilter = 'All';
  stateFilter = 'All';
  typeFilter = 'All';
  currentPage = 1;
  pageSize = 10;
  totalTicketsCount = 0;
  totalPagesFromServer = 1;
  currentView: 'home' | 'summary' | 'tickets' = 'home';
  sidebarOpen = false;

  // Active tickets across every project, used only by the Home page to
  // compute who's engaged vs free. Independent of selectedProject, since a
  // team lead needs to see workload regardless of which project someone's
  // busy on.
  homeTickets: Ticket[] = [];
  homeLoading = true;
  homeError = '';
  
  // Projects and team roster - loaded from the server's TEAM_MEMBERS/
  // PROJECTS_CONFIG env vars via loadConfig(), never hardcoded here so the
  // dashboard stays portable across orgs/teams.
  projects: Array<{ id: string; name: string; color: string }> = [];
  selectedProject = '';
  teamMembers: string[] = [];
  configLoading = true;
  configError = '';

  // Small fixed palette assigned to projects by load order, so each project
  // gets a stable, distinct color without needing one configured server-side.
  private readonly projectColorPalette = ['#4f46e5', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6'];

  theme: 'light' | 'dark' = 'light';

  // Single on-brand qualitative palette, shared by avatars and the member
  // chart so the same person always renders in the same color everywhere.
  private readonly avatarPalette = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#3b82f6'];

  private readonly priorityColors: Record<string, string> = {
    P0: '#ef4444',
    P1: '#f59e0b',
    P2: '#3b82f6',
    P3: '#94a3b8'
  };

  constructor(private ticketService: TicketService) {}

  ngOnInit(): void {
    this.initTheme();
    this.loadConfig();
  }

  // Fetches the team roster and project list first - everything else
  // (tickets/summary/home) depends on knowing which projects and team
  // members to scope those requests to.
  private loadConfig(): void {
    this.configLoading = true;
    this.configError = '';

    this.ticketService.getConfig().subscribe({
      next: (config) => {
        this.teamMembers = config.teamMembers;
        this.projects = config.projects.map((project, index) => ({
          ...project,
          color: this.projectColorPalette[index % this.projectColorPalette.length]
        }));
        this.selectedProject = this.projects[0]?.id || '';
        this.configLoading = false;

        this.loadTickets();
        this.loadSummary();
        this.loadHome();
      },
      error: (error) => {
        this.configLoading = false;
        this.loading = false;
        this.homeLoading = false;
        this.configError = error?.error?.message || 'Failed to load dashboard configuration.';
      }
    });
  }

  private initTheme(): void {
    const stored = localStorage.getItem('dashboard-theme');
    this.theme = stored === 'dark' || stored === 'light'
      ? stored
      : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', this.theme);
  }

  toggleTheme(): void {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', this.theme);
    localStorage.setItem('dashboard-theme', this.theme);
  }

  getInitials(name: string): string {
    if (!name || name === 'Unassigned') return '?';
    return name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('');
  }

  getAvatarColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return this.avatarPalette[Math.abs(hash) % this.avatarPalette.length];
  }

  // Fetches just the current page for the Tickets tab table, with the
  // search/assignee/state filters applied server-side so results stay correct
  // across pages - a ticket many pages deep in the default sort order is
  // still found by title/ID search, not just whatever's on the current page.
  loadTickets(): void {
    this.loading = true;
    this.errorMessage = '';

    this.ticketService.getTickets(this.selectedProject, {
      page: this.currentPage,
      pageSize: this.pageSize,
      assignedTo: this.assigneeFilter,
      state: this.stateFilter,
      type: this.typeFilter,
      search: this.searchTerm
    }).subscribe({
      next: (response) => {
        this.tickets = response.tickets || [];
        this.totalTicketsCount = response.total;
        this.totalPagesFromServer = response.totalPages || 1;
        this.loading = false;
      },
      error: (error) => {
        this.loading = false;
        this.errorMessage = error?.error?.message || 'Failed to load Azure DevOps tickets.';
      }
    });
  }

  // Fetches the full team-scoped ticket set (unpaginated) for the Summary
  // tab's totals and charts. This stays fast because it's already filtered
  // to the team on the server, unlike the old full-project fetch.
  loadSummary(): void {
    this.ticketService.getTickets(this.selectedProject, { pageSize: 'all' }).subscribe({
      next: (response) => {
        this.allTickets = response.tickets || [];
      },
      error: (error) => {
        this.errorMessage = error?.error?.message || 'Failed to load Azure DevOps tickets.';
      }
    });
  }

  onFilterChange(): void {
    this.currentPage = 1;
    this.loadTickets();
  }

  private searchDebounceHandle: ReturnType<typeof setTimeout> | null = null;

  onSearchChange(): void {
    if (this.searchDebounceHandle) {
      clearTimeout(this.searchDebounceHandle);
    }
    this.searchDebounceHandle = setTimeout(() => this.onFilterChange(), 400);
  }

  // Fetches Active tickets from every project (not just selectedProject) and
  // merges them - the Home page's workload view is org-wide by design, since
  // a team lead needs to see someone's total load, not just one project's.
  loadHome(): void {
    this.homeLoading = true;
    this.homeError = '';

    forkJoin(
      this.projects.map((project) =>
        this.ticketService.getTickets(project.id, { state: 'Active', pageSize: 'all', includeParentContext: true })
      )
    ).subscribe({
      next: (responses) => {
        this.homeTickets = responses.flatMap((response) => response.tickets || []);
        this.homeLoading = false;
      },
      error: (error) => {
        this.homeLoading = false;
        this.homeError = error?.error?.message || 'Failed to load team workload.';
      }
    });
  }

  refreshCurrent(): void {
    if (this.currentView === 'home') {
      this.loadHome();
      return;
    }
    this.loadTickets();
    this.loadSummary();
  }

  goToHome(): void {
    this.currentView = 'home';
    this.sidebarOpen = false;
  }

  selectedMember: MemberWorkload | null = null;

  openMemberDetail(member: MemberWorkload): void {
    this.selectedMember = member;
  }

  closeMemberDetail(): void {
    this.selectedMember = null;
  }

  private startOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private addWorkingDays(start: Date, days: number): Date {
    const result = new Date(start);
    let remaining = days;
    while (remaining > 0) {
      result.setDate(result.getDate() + 1);
      const day = result.getDay();
      if (day !== 0 && day !== 6) remaining--;
    }
    return result;
  }

  private nextWorkingDayAfter(date: Date): Date {
    return this.addWorkingDays(date, 1);
  }

  isOverdue(dueDate: string | null): boolean {
    if (!dueDate) return false;
    return this.startOfDay(new Date(dueDate)) < this.startOfDay(new Date());
  }

  formatFreeDate(date: Date | null): string {
    if (!date) return '—';
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  storyPointsLabel(ticket: Ticket): string {
    if (ticket.type !== 'Task') {
      const points = ticket.estimatedHours / HOURS_PER_STORY_POINT;
      return `${points} pt${points === 1 ? '' : 's'} · ${ticket.estimatedHours}h`;
    }
    return `${ticket.estimatedHours}h`;
  }

  getTypeTagClass(type: string): string {
    switch (type) {
      case 'Release': return 'type-release';
      case 'Epic': return 'type-epic';
      case 'Feature': return 'type-feature';
      case 'Task': return 'type-task';
      case 'Bug': return 'type-bug';
      case 'User Story':
      case 'Requirement':
      case 'Product Backlog Item':
        return 'type-story';
      default:
        return 'type-other';
    }
  }

  getTypeTagLabel(type: string): string {
    if (type === 'User Story') return 'Story';
    if (type === 'Product Backlog Item') return 'PBI';
    return type;
  }

  // Builds a member's tickets into trees following Azure DevOps' real
  // hierarchy - Epic > Feature > (User Story/Requirement/PBI/Bug) > Task -
  // as many levels deep as actually exist in this same list (a child whose
  // parent is assigned to someone else, or not in scope at all, just stays a
  // standalone root). Total hours avoid double-counting: a ticket only
  // contributes its own hours when no ancestor above it already carries an
  // estimate (Story Points or Original Estimate) - otherwise it's shown
  // nested for visibility only, since its work is already accounted for
  // higher up the chain.
  private buildTicketTree(tickets: Ticket[]): { groups: TicketNode[]; totalHours: number } {
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const childrenOf = new Map<number, Ticket[]>();

    tickets.forEach((t) => {
      if (t.parentId != null && byId.has(t.parentId)) {
        const list = childrenOf.get(t.parentId) || [];
        list.push(t);
        childrenOf.set(t.parentId, list);
      }
    });

    const buildNode = (ticket: Ticket): TicketNode => ({
      ticket,
      children: (childrenOf.get(ticket.id) || [])
        .sort((a, b) => (b.estimatedHours || 0) - (a.estimatedHours || 0))
        .map(buildNode)
    });

    const groups: TicketNode[] = tickets
      .filter((t) => t.parentId == null || !byId.has(t.parentId))
      .map(buildNode)
      .sort((a, b) => (b.ticket.estimatedHours || 0) - (a.ticket.estimatedHours || 0));

    // A context-only parent (backfilled purely to complete the chain, e.g. a
    // Release fetched only to nest an Epic under - see loadHome) never
    // contributes its own hours even if it happens to carry Story Points,
    // and never absorbs its children's hours either - otherwise real work
    // would silently vanish under a parent that isn't actually being counted.
    let totalHours = 0;
    const visit = (node: TicketNode, ancestorCovers: boolean): void => {
      const ownHoursCounted = !ancestorCovers && node.ticket.hasEstimate && !node.ticket.isContextOnly;
      if (ownHoursCounted) {
        totalHours += node.ticket.estimatedHours;
      }
      const covers = ancestorCovers || ownHoursCounted;
      node.children.forEach((child) => visit(child, covers));
    };
    groups.forEach((node) => visit(node, false));

    return { groups, totalHours };
  }

  // Pulls in whatever ancestor context tickets (see loadHome's
  // includeParentContext) are needed to complete a member's own tickets'
  // parent chain, regardless of who that ancestor is assigned to - a Release
  // or Epic is often owned by a lead, not the individual contributor whose
  // Task/Story sits underneath it.
  private withAncestorContext(ownTickets: Ticket[], globalById: Map<number, Ticket>): Ticket[] {
    const included = new Map<number, Ticket>(ownTickets.map((t) => [t.id, t]));
    let frontier = ownTickets;
    while (frontier.length) {
      const next: Ticket[] = [];
      for (const t of frontier) {
        if (t.parentId != null && !included.has(t.parentId)) {
          const parent = globalById.get(t.parentId);
          if (parent) {
            included.set(parent.id, parent);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
    return Array.from(included.values());
  }

  get teamWorkload(): MemberWorkload[] {
    const statusOrder: Record<MemberWorkload['status'], number> = { engaged: 0, unestimated: 1, free: 2 };
    const today = this.startOfDay(new Date());
    const globalById = new Map(this.homeTickets.map((t) => [t.id, t]));

    return this.teamMembers
      .map((name): MemberWorkload => {
        // Counts/due-date logic use only this person's own real active
        // tickets - context-only ancestors (see loadHome) are pulled in
        // separately, purely so buildTicketTree can nest under them.
        const ownTickets = this.homeTickets.filter((t) => t.assignedTo === name && !t.isContextOnly);
        const tickets = this.withAncestorContext(ownTickets, globalById);
        const { groups, totalHours } = this.buildTicketTree(tickets);
        const futureDue = ownTickets.filter((t) => t.dueDate && this.startOfDay(new Date(t.dueDate)) >= today);
        const hasOverdue = ownTickets.some((t) => t.dueDate && this.startOfDay(new Date(t.dueDate)) < today);

        let status: MemberWorkload['status'] = 'unestimated';
        let engagementBasis: MemberWorkload['engagementBasis'] = null;
        let daysNeeded = 0;
        let freeDate: Date | null = null;

        if (ownTickets.length === 0) {
          status = 'free';
        } else if (totalHours > 0) {
          // Logged hours are the most precise signal - prefer them when present.
          status = 'engaged';
          engagementBasis = 'hours';
          daysNeeded = Math.ceil(totalHours / HOURS_PER_DAY);
          freeDate = this.addWorkingDays(today, daysNeeded);
        } else if (futureDue.length > 0) {
          // No hours logged, but a real deadline is set - they're presumably
          // occupied with this ticket until (at least) that date.
          status = 'engaged';
          engagementBasis = 'dueDate';
          const maxDue = new Date(Math.max(...futureDue.map((t) => new Date(t.dueDate as string).getTime())));
          freeDate = this.nextWorkingDayAfter(maxDue);
        } else if (hasOverdue) {
          // Deadline already passed with no hours logged - still counts as
          // engaged (they're likely still working it), but projecting a free
          // date from a date already in the past wouldn't mean anything.
          status = 'engaged';
          engagementBasis = 'overdue';
        }

        const workloadPercent = Math.min((totalHours / WORKLOAD_BAR_CAP_HOURS) * 100, 100);

        return { name, status, engagementBasis, activeCount: ownTickets.length, totalHours, daysNeeded, freeDate, workloadPercent, tickets: ownTickets, groups };
      })
      .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || b.totalHours - a.totalHours);
  }

  get freeMemberCount(): number { return this.teamWorkload.filter((m) => m.status === 'free').length; }
  get engagedMemberCount(): number { return this.teamWorkload.filter((m) => m.status === 'engaged').length; }
  get unestimatedMemberCount(): number { return this.teamWorkload.filter((m) => m.status === 'unestimated').length; }
  get homeActiveTicketCount(): number { return this.homeTickets.filter((t) => !t.isContextOnly).length; }
  get homeTotalHours(): number {
    return Math.round(this.buildTicketTree(this.homeTickets).totalHours * 10) / 10;
  }

  normalizeState(state: string): string {
    if (!state) return 'Other';
    if (state.toLowerCase() === 'closed') return 'Closed';
    if (state.toLowerCase() === 'resolved') return 'Resolved';
    if (state.toLowerCase() === 'active') return 'Active';
    if (state.toLowerCase() === 'new') return 'New';
    return 'Other';
  }

  formatDate(dateString: string | null): string {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  formatDueDate(dateString: string | null): string {
    if (!dateString) return 'No due date';
    const date = new Date(dateString);
    return 'Due ' + date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  get totalPages(): number {
    return this.totalPagesFromServer;
  }

  private resetTableScroll(): void {
    if (this.tableWrapRef) {
      this.tableWrapRef.nativeElement.scrollTop = 0;
    }
  }

  nextPage(): void {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
      this.resetTableScroll();
      this.loadTickets();
    }
  }

  prevPage(): void {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.resetTableScroll();
      this.loadTickets();
    }
  }

  goToSummary(): void {
    this.currentView = 'summary';
  }

  goToTickets(): void {
    this.currentView = 'tickets';
    this.currentPage = 1;
  }

  selectProject(projectId: string): void {
    this.sidebarOpen = false;
    const projectChanged = projectId !== this.selectedProject;

    if (!projectChanged) {
      // Same project already selected - still need to leave Home (if that's
      // where we were) and show its Summary tab, just without refetching.
      this.currentView = 'summary';
      this.currentPage = 1;
      return;
    }

    this.selectedProject = projectId;
    this.currentView = 'summary';
    this.currentPage = 1;
    this.searchTerm = '';
    this.assigneeFilter = 'All';
    this.stateFilter = 'All';
    this.typeFilter = 'All';
    this.loadTickets();
    this.loadSummary();
  }

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }

  get currentProjectName(): string {
    return this.projects.find(p => p.id === this.selectedProject)?.name || 'Unknown Project';
  }

  get currentProjectColor(): string {
    return this.projects.find(p => p.id === this.selectedProject)?.color || '#4f46e5';
  }

  get totalTickets(): number { return this.allTickets.length; }
  get activeTickets(): number { return this.allTickets.filter((ticket) => this.normalizeState(ticket.state) === 'Active').length; }
  get closedTickets(): number { return this.allTickets.filter((ticket) => this.normalizeState(ticket.state) === 'Closed').length; }
  get resolvedTickets(): number { return this.allTickets.filter((ticket) => this.normalizeState(ticket.state) === 'Resolved').length; }
  get newTickets(): number { return this.allTickets.filter((ticket) => this.normalizeState(ticket.state) === 'New').length; }

  get stateOptions(): string[] {
    return ['All', 'New', 'Active', 'Resolved', 'Closed'];
  }

  getStateColor(state: string): string {
    const normalized = this.normalizeState(state);
    switch (normalized) {
      case 'Closed':
        return '#10b981';
      case 'Resolved':
        return '#14b8a6';
      case 'Active':
        return '#3b82f6';
      case 'New':
        return '#f59e0b';
      default:
        return '#6b7280';
    }
  }

  get assigneeOptions(): string[] {
    return ['All', ...this.teamMembers];
  }

  // Work item types aren't a fixed set across Azure DevOps process templates
  // (unlike state), so the dropdown is built from whatever types actually
  // show up in this project's team-scoped tickets rather than a hardcoded list.
  get typeOptions(): string[] {
    const types = new Set(this.allTickets.map((ticket) => ticket.type).filter(Boolean));
    return ['All', ...Array.from(types).sort()];
  }

  get stateChart(): Array<{ label: string; value: number; color: string }> {
    const totals: Record<string, number> = {};

    this.allTickets.forEach((ticket) => {
      const normalizedState = this.normalizeState(ticket.state);
      totals[normalizedState] = (totals[normalizedState] || 0) + 1;
    });

    const colors: Record<string, string> = {
      'Closed': '#10b981',
      'Resolved': '#14b8a6',
      'Active': '#3b82f6',
      'New': '#f59e0b',
      'Other': '#6b7280'
    };

    return Object.entries(totals).map(([label, value]) => ({
      label,
      value,
      color: colors[label] || '#6b7280'
    }));
  }

  get memberChart(): Array<{ label: string; value: number; color: string }> {
    const totals: Record<string, number> = {};

    this.allTickets.forEach((ticket) => {
      totals[ticket.assignedTo] = (totals[ticket.assignedTo] || 0) + 1;
    });

    // Reuse getAvatarColor() so a person's chart bar always matches their
    // avatar color in the table, instead of a second, order-dependent palette.
    return Object.entries(totals).map(([label, value]) => ({
      label,
      value,
      color: this.getAvatarColor(label)
    }));
  }

  get priorityChart(): Array<{ label: string; value: number; color: string }> {
    const totals: Record<string, number> = {};

    this.allTickets.forEach((ticket) => {
      const label = `P${ticket.priority || 0}`;
      totals[label] = (totals[label] || 0) + 1;
    });

    // Sort by priority number (P0 first) and color by what the priority means,
    // not by the order priorities happened to appear in the fetched tickets.
    return Object.entries(totals)
      .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
      .map(([label, value]) => ({
        label,
        value,
        color: this.priorityColors[label] || '#94a3b8'
      }));
  }

  get maxChartValue(): number {
    const combined = [...this.stateChart, ...this.memberChart, ...this.priorityChart];
    const values = combined.map((item) => item.value);
    return values.length ? Math.max(...values) : 1;
  }

  openTicket(ticket: Ticket): void {
    if (ticket.link) {
      window.open(ticket.link, '_blank', 'noopener,noreferrer');
    }
  }
}
