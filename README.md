# Project Sentinel

## Ver

0.1.0 (260425)

## 기능

법령,법령해석(비조치의견서),과거검토문서 등을 참조로 이슈에 대한 검토결론을 내리고, HWPX 보고서작업을 위한 개조식 변환을 담당하는 LLM Agent 기반 프로젝트

## Stage 구분

- Stage1 : 이슈를 input하면 법령mcp, 법령해석mcp, 검토문서mcp를 도구로 Agent가 Claude API 기반 루핑하며 검토결론을 내림

- Stage2 : md spec에 맞게 검토결론을 개조식 markdown으로 변환

## 기타

- 각 단계별로 AI가 1차 산출물을 내면, 이것에 대한 피드백을 통해 재가공할 수 있음  
- Agent는 각 단계를 후퇴하지 않음  
- 사람은 필요에 따라 직전단계 산출물과 유사한 input을 후방단계에게 manual로 제공할 수 있음  