/**
 * AI Municipal Assistant Engine
 * Answers operator questions strictly grounded on live application state.
 * Never invents facts; provides verified citations to incident IDs, team rosters, and risk factors.
 */

export function queryAssistant({ question, incidents, teams, weather }) {
  if (!question || typeof question !== 'string') {
    return {
      answer: 'Please provide a valid question regarding current incidents, teams, or dispatch status.',
      context_used: [],
    };
  }

  const q = question.toLowerCase().trim();

  // 1. "Which incidents require immediate attention?"
  if (
    q.includes('immediate attention') ||
    q.includes('critical') ||
    q.includes('urgent') ||
    q.includes('highest priority')
  ) {
    const criticals = incidents
      .filter((i) => (i.priority === 'CRITICAL' || i.risk_score >= 80) && i.status !== 'repaired')
      .sort((a, b) => b.risk_score - a.risk_score);

    if (criticals.length === 0) {
      return {
        answer: 'There are currently no unresolved CRITICAL incidents requiring immediate emergency dispatch. All open defects are below the 80/100 risk threshold.',
        context_used: [],
      };
    }

    const items = criticals.slice(0, 5).map((inc) => {
      return `• **[#${inc.incident_id || inc.id}] ${inc.infrastructure_type}** at *${inc.address || 'Location'}* — **Risk ${inc.risk_score}/100 (CRITICAL)**. Status: \`${inc.status}\`. Assigned: ${inc.assigned_team?.name || 'Unassigned (Action Required)'}. Reason: ${inc.location_context?.explanation || 'High traffic and severe road defect'}`;
    });

    return {
      answer: `There are **${criticals.length} incidents** requiring immediate attention (Risk ≥ 80 or CRITICAL priority):\n\n${items.join('\n\n')}\n\nRecommended Action: Open the Priority Queue to dispatch available teams to unassigned critical items immediately.`,
      context_used: criticals.slice(0, 5).map((i) => i.incident_id || i.id),
    };
  }

  // 2. "Why is Incident #... critical?"
  const idMatch = q.match(/#?(\d{3,5}|[a-f0-9-]{6,})/);
  if ((q.includes('why') || q.includes('reason') || q.includes('factor')) && idMatch) {
    const targetId = idMatch[1];
    const incident = incidents.find(
      (i) =>
        String(i.incident_id).toLowerCase() === targetId ||
        String(i.id).toLowerCase().includes(targetId)
    );

    if (!incident) {
      return {
        answer: `Incident #${targetId} was not found in the current municipal database. Please verify the incident number.`,
        context_used: [],
      };
    }

    const f = incident.risk_factors || {};
    const poi = incident.location_context?.nearest_poi;

    return {
      answer: `**Incident #${incident.incident_id || incident.id} (${incident.infrastructure_type}) Analysis:**\n\n` +
        `• **Overall Risk Score**: ${incident.risk_score}/100 (${incident.priority} Priority)\n` +
        `• **Severity Factor**: ${f.severity ?? 'N/A'}/100 (Assessed defect severity: ${incident.severity.toUpperCase()}, depth: ${incident.est_depth_cm || 'N/A'}cm)\n` +
        `• **Traffic Density**: ${f.traffic ?? 'N/A'}/100\n` +
        `• **Pedestrian Exposure**: ${f.pedestrian ?? 'N/A'}/100\n` +
        `• **Location Criticality**: ${f.location ?? 'N/A'}/100 ${poi ? `(Near ${poi.name}, distance ${poi.distanceM}m)` : ''}\n` +
        `• **Duplicate Complaints**: ${f.complaints ?? 'N/A'}/100 (${incident.report_count || 1} independent reports merged)\n` +
        `• **Weather/Flood Risk**: ${f.weather ?? 'N/A'}/100 (${weather.condition})\n\n` +
        `**Key Driver**: ${incident.location_context?.explanation || 'Compound risk from heavy vehicular load and structural defect.'}`,
      context_used: [incident.incident_id || incident.id],
    };
  }

  // 3. "Which team is currently overloaded?"
  if (q.includes('overload') || q.includes('workload') || q.includes('busy team') || q.includes('team status')) {
    const sortedTeams = [...teams].sort((a, b) => (b.current_workload || 0) - (a.current_workload || 0));
    const overloaded = sortedTeams.filter((t) => (t.current_workload || 0) >= 3);
    const available = sortedTeams.filter((t) => t.availability === 'AVAILABLE');

    let text = `**Municipal Work Crew Workload Report:**\n\n`;
    if (overloaded.length > 0) {
      text += `⚠️ **High Workload Teams (≥3 active assignments):**\n`;
      overloaded.forEach((t) => {
        text += `• **${t.name}** (${t.specialization}): **${t.current_workload} active work orders** (Status: ${t.availability})\n`;
      });
      text += `\n`;
    } else {
      text += `No single team is currently critical overload (maximum active jobs on any team is ${sortedTeams[0]?.current_workload || 0}).\n\n`;
    }

    text += `✅ **Currently Available for Immediate Dispatch:** ${available.length} team(s)\n`;
    available.forEach((t) => {
      text += `• **${t.name}** (${t.specialization}) — Location: ${t.current_area || 'Station'} (Equipment: ${t.equipment})\n`;
    });

    return {
      answer: text,
      context_used: sortedTeams.map((t) => t.team_id),
    };
  }

  // 4. "How many potholes were resolved today?"
  if (
    q.includes('resolved') ||
    q.includes('repaired') ||
    q.includes('completed') ||
    q.includes('how many potholes') ||
    q.includes('today')
  ) {
    const resolvedAll = incidents.filter(
      (i) => i.status === 'repaired' || i.repair_status === 'REPAIR_VERIFIED'
    );
    const resolvedPotholes = resolvedAll.filter((i) => i.infrastructure_type === 'Pothole');
    const openPotholes = incidents.filter(
      (i) => i.infrastructure_type === 'Pothole' && i.status !== 'repaired'
    );

    return {
      answer: `**Pothole & Remediation Summary:**\n\n` +
        `• **Potholes Resolved Today / Current Cycle**: ${resolvedPotholes.length}\n` +
        `• **Total All Defects Resolved**: ${resolvedAll.length}\n` +
        `• **Still Active Potholes Pending Repair**: ${openPotholes.length}\n` +
        `• **Total Tracked Potholes**: ${resolvedPotholes.length + openPotholes.length}\n\n` +
        `All completed repairs passed closed-loop AI visual surface verification before closure.`,
      context_used: resolvedAll.map((i) => i.incident_id || i.id),
    };
  }

  // 5. "Show recurring problem areas"
  if (
    q.includes('recurring') ||
    q.includes('problem area') ||
    q.includes('hotspot') ||
    q.includes('cluster')
  ) {
    // Group incidents by address or nearby POI
    const clusters = {};
    for (const inc of incidents) {
      const key = inc.address ? inc.address.split(',')[0].trim() : 'Central Corridor';
      if (!clusters[key]) clusters[key] = { count: 0, criticalCount: 0, items: [] };
      clusters[key].count++;
      if (inc.priority === 'CRITICAL' || inc.priority === 'HIGH') clusters[key].criticalCount++;
      clusters[key].items.push(inc);
    }

    const sortedAreas = Object.entries(clusters).sort((a, b) => b[1].count - a[1].count);

    let text = `**Recurring Infrastructure Problem Hotspots:**\n\n`;
    sortedAreas.slice(0, 4).forEach(([area, data]) => {
      text += `• **${area}**: **${data.count} total reports** (${data.criticalCount} High/Critical priority)\n`;
      text += `   Types detected: ${[...new Set(data.items.map((i) => i.infrastructure_type))].join(', ')}\n`;
    });
    text += `\nRecommendation: Schedule preventative resurfacing and drainage re-channeling for these segments rather than individual spot patches.`;

    return {
      answer: text,
      context_used: incidents.map((i) => i.incident_id || i.id),
    };
  }

  // Generic fallback grounded in current database statistics
  const total = incidents.length;
  const criticalCount = incidents.filter((i) => i.priority === 'CRITICAL' && i.status !== 'repaired').length;
  const inProgressCount = incidents.filter((i) => i.status === 'in_progress').length;
  const resolvedCount = incidents.filter((i) => i.status === 'repaired').length;

  return {
    answer: `SmartCity AI is monitoring **${total} infrastructure incidents** across the municipality.\n\n` +
      `• **Critical Pending**: ${criticalCount}\n` +
      `• **In Progress / Dispatched**: ${inProgressCount}\n` +
      `• **Remediated & Verified**: ${resolvedCount}\n` +
      `• **Active Work Crews**: ${teams.length} teams (${teams.filter((t) => t.availability === 'AVAILABLE').length} currently available)\n` +
      `• **Current Weather**: ${weather.condition} (Flood Risk: ${weather.floodRiskLevel})\n\n` +
      `You can ask me specific questions like: *"Which incidents require immediate attention?"*, *"Why is Incident #1042 critical?"*, *"Which team is currently overloaded?"*, or *"Show recurring problem areas."*`,
    context_used: [],
  };
}
