# FailureLens Knowledge Graph Report
- **Repository**: `FailureLens`
- **Components (Nodes)**: 281
- **Dependencies (Directed Edges)**: 705
- **Feature Communities**: 12

## Feature Communities
- **Feature: Providers**: 48 components
- **Feature: Services**: 47 components
- **Feature: Services**: 42 components
- **Feature: Services**: 30 components
- **Feature: Providers**: 27 components
- **Feature: Services**: 26 components
- **Feature: Tests**: 23 components
- **Feature: Services**: 16 components
- **Feature: Checkout**: 12 components
- **Feature: Db**: 8 components
- **Feature: Checkout**: 1 components
- **Feature: Samples**: 1 components

## Critical Nodes (High Fan-In Architectural Bottlenecks)
- `Hypothesis` (`extension/src/types/index.ts`) — Fan-in (In-Degree): 18, Total Degree: 18
- `KnowledgeGraphService` (`extension/src/services/knowledgeGraphService.ts`) — Fan-in (In-Degree): 16, Total Degree: 50
- `RiskAnalysisService` (`extension/src/services/riskAnalysisService.ts`) — Fan-in (In-Degree): 16, Total Degree: 46
- `AffectedComponent` (`extension/src/types/index.ts`) — Fan-in (In-Degree): 13, Total Degree: 13
- `ref_vscode` (``) — Fan-in (In-Degree): 13, Total Degree: 13
- `IncidentService` (`extension/src/services/incidentService.ts`) — Fan-in (In-Degree): 11, Total Degree: 17