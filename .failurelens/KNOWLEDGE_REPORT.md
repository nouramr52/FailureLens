# FailureLens Knowledge Graph Report
- **Repository**: `FailureLens`
- **Components (Nodes)**: 152
- **Dependencies (Directed Edges)**: 409
- **Feature Communities**: 8

## Feature Communities
- **Feature: Services**: 34 components
- **Feature: Types**: 29 components
- **Feature: Providers**: 26 components
- **Feature: Providers**: 21 components
- **Feature: Providers**: 16 components
- **Feature: Services**: 10 components
- **Feature: Services**: 8 components
- **Feature: Db**: 8 components

## Critical Nodes (High Fan-In Architectural Bottlenecks)
- `RiskAnalysisService` (`extension/src/services/riskAnalysisService.ts`) — Fan-in (In-Degree): 16, Total Degree: 28
- `KnowledgeGraphService` (`extension/src/services/knowledgeGraphService.ts`) — Fan-in (In-Degree): 15, Total Degree: 33
- `ref_vscode` (``) — Fan-in (In-Degree): 13, Total Degree: 13
- `IncidentService` (`extension/src/services/incidentService.ts`) — Fan-in (In-Degree): 11, Total Degree: 17
- `Hypothesis` (`extension/src/types/index.ts`) — Fan-in (In-Degree): 11, Total Degree: 11
- `AffectedComponent` (`extension/src/types/index.ts`) — Fan-in (In-Degree): 9, Total Degree: 9