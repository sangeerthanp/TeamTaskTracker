const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const organization = process.env.AZURE_ORG;
const pat = process.env.AZURE_PAT;

// Team roster, one entry per member: { name, email }. name is display-only
// (labels/initials) - email is the identity key used for WIQL identity
// matching, the assignee filter, and matching a ticket's assignee back to a
// roster member. Azure DevOps display names alone aren't unique, so keying
// on name would silently merge two people who happen to share one. JSON
// array in TEAM_MEMBERS, same style as PROJECTS_CONFIG. See .env.example.
let TEAM_MEMBERS = [];
try {
  const parsedMembers = JSON.parse(process.env.TEAM_MEMBERS || "[]");
  TEAM_MEMBERS = parsedMembers.map((m) => ({ name: m.name, email: m.email }));
} catch (err) {
  console.error("[Config] TEAM_MEMBERS is not valid JSON:", err.message);
}

// Case-insensitive lookup so a query param's casing (or Azure DevOps'
// returned casing) doesn't have to match the config file's exactly.
const TEAM_MEMBERS_BY_EMAIL = new Map(TEAM_MEMBERS.map((m) => [m.email.toLowerCase(), m]));

const STATE_FILTER_TO_AZURE_STATE = {
  New: 'New',
  Active: 'Active',
  Resolved: 'Resolved',
  Closed: 'Closed'
};

const HOURS_PER_STORY_POINT = 8;

// Project configurations, one dashboard project per entry: { id, name,
// azureProject, areaPath }. azureProject/areaPath are internal Azure DevOps
// details and never sent to the frontend (see /api/config) - only id/name
// are. Configured as a JSON array in PROJECTS_CONFIG. See .env.example.
let projectConfigs = {};
try {
  const parsedProjects = JSON.parse(process.env.PROJECTS_CONFIG || "[]");
  projectConfigs = Object.fromEntries(parsedProjects.map((p) => [p.id, p]));
} catch (err) {
  console.error("[Config] PROJECTS_CONFIG is not valid JSON:", err.message);
}

app.use(cors());
app.use(express.json());

function validateConfig() {
  if (!organization || !pat) {
    const missing = [];
    if (!organization) missing.push("AZURE_ORG");
    if (!pat) missing.push("AZURE_PAT");

    return {
      valid: false,
      message: `Missing Azure DevOps environment variables: ${missing.join(", ")}`
    };
  }

  return { valid: true };
}

function getErrorMessage(error) {
  if (error?.response?.data) {
    const data = error.response.data;
    if (typeof data === "string") return data;
    if (data?.message) return data.message;
    if (data?.error?.message) return data.error.message;
  }

  return error?.message || "Unknown Azure DevOps error";
}

function getAuthHeaders() {
  const auth = Buffer.from(`:${pat}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json"
  };
}

function logAzureCall(stage, url, payload) {
  console.log(`[Azure DevOps] ${stage}`);
  console.log(`[Azure DevOps] URL: ${url}`);
  if (payload) {
    console.log(`[Azure DevOps] Payload: ${JSON.stringify(payload, null, 2)}`);
  }
}

function buildProjectUrlForConfig(azureProjectName, path) {
  const safeProject = encodeURIComponent(azureProjectName);
  return `https://dev.azure.com/${organization}/${safeProject}${path}`;
}

function escapeWiqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

// Maps a raw Azure DevOps work item to the shape the frontend consumes.
// isContextOnly marks an item that was fetched purely to complete a parent
// chain for hierarchy display (e.g. a Release above an Epic) - it wasn't
// itself part of the Active/team-scoped query, so callers exclude it from
// active-ticket counts and hour totals, using it only for tree structure.
function mapWorkItemToTicket(item, projectConfig, isContextOnly) {
  const fields = item.fields || {};
  const assigned = fields["System.AssignedTo"];
  const type = fields["System.WorkItemType"] || "";

  // Hours are computed differently per work item type, since Azure DevOps
  // tracks size differently for each:
  // - Task: Original Estimate (hours), set directly by the assignee.
  // - Everything else (User Story, Bug, Requirement, PBI, Feature, Epic...):
  //   Story Points, converted at 8 hours/point, if that backlog-level type
  //   has been given points. A parent's child items are NOT summed in here -
  //   that would double-count the same work. The frontend decides whether to
  //   use a child's own hours or defer to its parent's total, walking up
  //   however many hierarchy levels are actually present (Release > Epic >
  //   Feature > Story/Bug > Task).
  let hasEstimate = false;
  let estimatedHours = 0;
  if (type === "Task") {
    const originalEstimate = fields["Microsoft.VSTS.Scheduling.OriginalEstimate"];
    hasEstimate = originalEstimate != null;
    estimatedHours = hasEstimate ? Number(originalEstimate) : 0;
  } else {
    const storyPoints = fields["Microsoft.VSTS.Scheduling.StoryPoints"];
    hasEstimate = storyPoints != null;
    estimatedHours = hasEstimate ? Number(storyPoints) * HOURS_PER_STORY_POINT : 0;
  }

  // Completed Work only exists as a trackable field on Tasks in Azure DevOps
  // (the same as Original Estimate above) - backlog-level types (User Story,
  // Bug, Feature, Epic...) are sized in Story Points and have no hours-worked
  // field of their own, so they simply have no completed-hours value.
  const completedWork = fields["Microsoft.VSTS.Scheduling.CompletedWork"];
  const hasCompletedHours = type === "Task" && completedWork != null;
  const completedHours = hasCompletedHours ? Number(completedWork) : 0;

  // A bare iteration path (just the project name, no sprint node under it)
  // means no sprint was ever assigned - only show one when there's an actual
  // sprint segment beneath the project root.
  const iterationSegments = fields["System.IterationPath"] ? fields["System.IterationPath"].split("\\") : [];
  const sprint = iterationSegments.length > 1 ? iterationSegments[iterationSegments.length - 1] : null;

  return {
    id: item.id,
    title: fields["System.Title"] || "",
    state: fields["System.State"] || "",
    assignedTo: assigned?.displayName || "Unassigned",
    // Identity key for matching this ticket back to a TEAM_MEMBERS roster
    // entry - null when unassigned, since there's no identity object at all.
    assignedToEmail: assigned?.uniqueName || null,
    type,
    parentId: fields["System.Parent"] || null,
    sprint,
    priority: Number(fields["Microsoft.VSTS.Common.Priority"] ?? 0),
    createdDate: fields["System.CreatedDate"] || null,
    changedDate: fields["System.ChangedDate"] || null,
    dueDate: fields["Microsoft.VSTS.Scheduling.DueDate"] || null,
    estimatedHours,
    hasEstimate,
    completedHours,
    hasCompletedHours,
    isContextOnly: !!isContextOnly,
    link: `https://dev.azure.com/${organization}/${projectConfig.azureProject}/_workitems/edit/${item.id}`
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: "Azure DevOps Team Dashboard API is running."
  });
});

// Public, non-secret dashboard config the frontend needs at startup - just
// project ids/names and the team roster. azureProject/areaPath internals
// stay server-side only.
app.get("/api/config", (req, res) => {
  res.json({
    teamMembers: TEAM_MEMBERS,
    projects: Object.entries(projectConfigs).map(([id, config]) => ({ id, name: config.name }))
  });
});

app.get("/api/tickets", async (req, res) => {
  const projectId = req.query.project || Object.keys(projectConfigs)[0];
  const projectConfig = projectConfigs[projectId];

  if (!projectConfig) {
    return res.status(400).json({
      success: false,
      message: `Project '${projectId}' not found.`,
      errorCode: "PROJECT_NOT_FOUND"
    });
  }

  const configCheck = validateConfig();

  if (!configCheck.valid) {
    return res.status(500).json({
      success: false,
      message: configCheck.message,
      errorCode: "CONFIG_ERROR"
    });
  }

  // Optional server-side filters. assignedTo/state are validated against known
  // allow-lists before being interpolated into the WIQL query. assignedTo is
  // an email (case-insensitive) - the matched roster entry's own stored
  // casing is used below, never the raw query param, so this stays a strict
  // allow-list rather than a pass-through.
  const assignedToRosterEntry = typeof req.query.assignedTo === "string"
    ? TEAM_MEMBERS_BY_EMAIL.get(req.query.assignedTo.toLowerCase())
    : null;
  const stateFilter = Object.prototype.hasOwnProperty.call(STATE_FILTER_TO_AZURE_STATE, req.query.state)
    ? STATE_FILTER_TO_AZURE_STATE[req.query.state]
    : null;
  // Work item types vary by Azure DevOps process template, so (unlike state)
  // there's no fixed allow-list here - the value is escaped the same way
  // searchTerm is below, which is enough to keep it safe inside the WIQL literal.
  const typeFilter = typeof req.query.type === "string" && req.query.type.trim() && req.query.type !== "All"
    ? req.query.type.trim()
    : null;
  const searchTerm = typeof req.query.search === "string" ? req.query.search.trim() : "";
  // Only the Home page's hierarchy view needs parent backfill - the paginated
  // Tickets tab doesn't render a tree, so skip the extra API calls there.
  const includeParentContext = req.query.includeParentContext === "true";

  // pageSize=all disables pagination (used for summary/chart data, which stays
  // small because it's already scoped to TEAM_MEMBERS).
  const paginate = req.query.pageSize !== "all";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(1, parseInt(req.query.pageSize, 10) || 10);

  try {
    // Matched by bare display name, not email - Microsoft's documented
    // "Display Name <email>" combined form (and a bare email/unique-name
    // literal) were both verified against this org to match zero items, even
    // for a confirmed-correct identity. Display name is what's actually
    // proven to work here. This can still be ambiguous when two roster
    // members share a display name, but that's fine at this stage: it only
    // narrows which work item ids get fetched below, not who a ticket is
    // ultimately attributed to - that happens after fetch, keyed on the
    // authoritative email from the item's own AssignedTo field (see
    // assignedToRosterEntry filtering below and assignedToEmail throughout).
    const teamList = TEAM_MEMBERS.map((m) => `'${escapeWiqlLiteral(m.name)}'`).join(", ");
    const conditions = [
      `[System.AreaPath] UNDER '${escapeWiqlLiteral(projectConfig.areaPath)}'`,
      `[System.AssignedTo] IN (${teamList})`
    ];
    if (assignedToRosterEntry) {
      conditions.push(`[System.AssignedTo] = '${escapeWiqlLiteral(assignedToRosterEntry.name)}'`);
    }
    if (stateFilter) {
      conditions.push(`[System.State] = '${escapeWiqlLiteral(stateFilter)}'`);
    }
    if (typeFilter) {
      conditions.push(`[System.WorkItemType] = '${escapeWiqlLiteral(typeFilter)}'`);
    }
    if (searchTerm) {
      // Searches by title text across the whole filtered set (not just the
      // current page) - a ticket can otherwise sit dozens of pages deep in
      // the default ChangedDate-sorted list and look "missing" to the search
      // box even though it exists.
      const searchClauses = [`[System.Title] CONTAINS '${escapeWiqlLiteral(searchTerm)}'`];
      if (/^\d+$/.test(searchTerm)) {
        searchClauses.push(`[System.Id] = ${parseInt(searchTerm, 10)}`);
      }
      conditions.push(`(${searchClauses.join(" OR ")})`);
    }

    const wiqlUrl = buildProjectUrlForConfig(projectConfig.azureProject, "/_apis/wit/wiql?api-version=7.1&$top=10000");
    const wiqlQuery = `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;

    logAzureCall("WIQL request", wiqlUrl, { query: wiqlQuery });

    const wiqlResponse = await axios.post(
      wiqlUrl,
      { query: wiqlQuery },
      {
        headers: getAuthHeaders(),
        validateStatus: (status) => status < 500
      }
    );

    if (wiqlResponse.status !== 200) {
      const message = getErrorMessage({ response: wiqlResponse });
      console.error("[Azure DevOps] WIQL request failed", wiqlResponse.status, message);
      return res.status(wiqlResponse.status).json({
        success: false,
        message: "Azure DevOps WIQL query failed.",
        error: message,
        statusCode: wiqlResponse.status
      });
    }

    const workItems = wiqlResponse.data?.workItems || [];
    const matchedCount = workItems.length;
    console.log(`[Azure DevOps] WIQL returned ${matchedCount} work item ids.`);

    if (matchedCount === 0) {
      return res.json({ tickets: [], total: 0, page, pageSize, totalPages: 0 });
    }

    const allIds = workItems.map((item) => item.id);
    // A single-assignee filter only narrows the WIQL match by display name
    // (see the comment above conditions) - when two roster members share a
    // name, the matched id set can include both. To attribute each ticket to
    // the exact person, every candidate's details must be fetched (not just
    // one page) and filtered by email before pagination is applied, rather
    // than slicing ids into a page up front. Without an assignee filter, the
    // matched set is already exactly what's being shown, so the cheaper
    // page-slice-before-fetch path is unchanged.
    const needsFullFetch = !paginate || !!assignedToRosterEntry;
    const idsToFetch = needsFullFetch ? allIds : allIds.slice((page - 1) * pageSize, page * pageSize);

    // Fetch in batches of 200 to avoid URL length limits (a single page is
    // almost always one batch; only the unpaginated summary call needs more).
    const batchSize = 200;
    const batches = [];
    for (let i = 0; i < idsToFetch.length; i += batchSize) {
      batches.push(idsToFetch.slice(i, i + batchSize));
    }

    console.log(`[Azure DevOps] Fetching ${idsToFetch.length} of ${matchedCount} work item(s) in ${batches.length} batch(es).`);

    // Azure DevOps only returns a small default field set unless the exact
    // fields are requested - without this, the scheduling fields below come
    // back undefined even when Azure DevOps has real values for them.
    const requestedFields = [
      "System.Id",
      "System.Title",
      "System.State",
      "System.AssignedTo",
      "System.WorkItemType",
      "System.Parent",
      "System.IterationPath",
      "Microsoft.VSTS.Common.Priority",
      "System.CreatedDate",
      "System.ChangedDate",
      "Microsoft.VSTS.Scheduling.OriginalEstimate",
      "Microsoft.VSTS.Scheduling.StoryPoints",
      "Microsoft.VSTS.Scheduling.DueDate",
      "Microsoft.VSTS.Scheduling.CompletedWork"
    ].join(",");

    const allDetails = [];
    for (const batch of batches) {
      const detailsUrl = buildProjectUrlForConfig(projectConfig.azureProject, `/_apis/wit/workitems?ids=${batch.join(",")}&fields=${requestedFields}&api-version=7.1`);
      logAzureCall("Work item detail request", `Batch of ${batch.length} items`, { count: batch.length });

      const detailsResponse = await axios.get(detailsUrl, {
        headers: getAuthHeaders(),
        validateStatus: (status) => status < 500
      });

      if (detailsResponse.status !== 200) {
        const message = getErrorMessage({ response: detailsResponse });
        console.error("[Azure DevOps] Work item details failed", detailsResponse.status, message);
        return res.status(detailsResponse.status).json({
          success: false,
          message: "Azure DevOps work item detail request failed.",
          error: message,
          statusCode: detailsResponse.status
        });
      }

      allDetails.push(...(detailsResponse.data?.value || []));
    }

    // Azure DevOps doesn't guarantee the details response preserves ID order.
    const detailsById = new Map(allDetails.map((item) => [item.id, item]));
    let result = idsToFetch
      .map((id) => detailsById.get(id))
      .filter(Boolean)
      .map((item) => mapWorkItemToTicket(item, projectConfig, false));

    // The precise per-person cut - narrows the display-name-matched
    // candidates above down to exactly this email, using the authoritative
    // identity from the item's own AssignedTo field.
    if (assignedToRosterEntry) {
      result = result.filter((t) =>
        t.assignedToEmail && t.assignedToEmail.toLowerCase() === assignedToRosterEntry.email.toLowerCase()
      );
    }

    // Only recomputed post-filter when a single-assignee filter actually
    // changed the candidate set - otherwise idsToFetch/matchedCount already
    // are the exact page/total being returned.
    const total = assignedToRosterEntry ? result.length : matchedCount;
    const pageResult = (paginate && assignedToRosterEntry)
      ? result.slice((page - 1) * pageSize, page * pageSize)
      : result;

    // Backfill any parent not already in the result set (e.g. a Release
    // above an Epic, or a Feature's own parent) so the hierarchy view can
    // nest under it correctly instead of showing it as a disconnected root.
    // These parents are fetched regardless of their own state/assignee -
    // they're structural context, not part of the person's active workload.
    const contextTickets = [];
    if (includeParentContext) {
      const knownIds = new Set(pageResult.map((t) => t.id));
      let frontierIds = [...new Set(pageResult.map((t) => t.parentId).filter((id) => id != null && !knownIds.has(id)))];
      const MAX_CONTEXT_DEPTH = 6;

      for (let depth = 0; frontierIds.length && depth < MAX_CONTEXT_DEPTH; depth += 1) {
        const fetchUrl = buildProjectUrlForConfig(projectConfig.azureProject, `/_apis/wit/workitems?ids=${frontierIds.join(",")}&fields=${requestedFields}&api-version=7.1`);
        logAzureCall("Parent context request", fetchUrl, { count: frontierIds.length, depth });

        const parentResponse = await axios.get(fetchUrl, {
          headers: getAuthHeaders(),
          validateStatus: (status) => status < 500
        });

        if (parentResponse.status !== 200) {
          // Parent context is a nice-to-have for hierarchy display - don't
          // fail the whole request just because it couldn't be fetched.
          console.error("[Azure DevOps] Parent context request failed", parentResponse.status);
          break;
        }

        const parentItems = parentResponse.data?.value || [];
        parentItems.forEach((item) => knownIds.add(item.id));
        const mapped = parentItems.map((item) => mapWorkItemToTicket(item, projectConfig, true));
        contextTickets.push(...mapped);

        frontierIds = [...new Set(mapped.map((t) => t.parentId).filter((id) => id != null && !knownIds.has(id)))];
      }
    }

    const combinedTickets = [...pageResult, ...contextTickets];
    console.log(`[Azure DevOps] Returning ${pageResult.length} mapped tickets + ${contextTickets.length} parent-context tickets (page ${page}, total ${total}).`);
    return res.json({
      tickets: combinedTickets,
      total,
      page,
      pageSize: paginate ? pageSize : total,
      totalPages: paginate ? Math.ceil(total / pageSize) : 1
    });
  } catch (error) {
    console.error("[Azure DevOps] Request failed.");

    if (error.response) {
      console.error("[Azure DevOps] Status:", error.response.status);
      console.error("[Azure DevOps] Response data:", JSON.stringify(error.response.data, null, 2));
    } else {
      console.error("[Azure DevOps] Error:", error.message);
    }

    const status = error.response?.status || 500;
    const message = getErrorMessage(error);

    return res.status(status).json({
      success: false,
      message: "Failed to fetch Azure DevOps tickets.",
      error: message,
      statusCode: status
    });
  }
});

// app.listen only runs for local/traditional hosting - on Vercel this file
// is required by api/index.js and exported as a serverless function handler
// instead, so it must never call listen() there.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("Azure config loaded:", {
      org: !!organization,
      pat: !!pat,
      projects: Object.keys(projectConfigs),
      teamMembers: TEAM_MEMBERS.length
    });
  });
}

module.exports = app;
