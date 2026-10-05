# Glossary

Domain language used across code, API and UI. Prefer these names over synonyms.

| Term                  | Meaning                                                                                                                                                 | In code                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Learning Cycle**    | A programme year (e.g. 2026). Exactly one is _current_.                                                                                                 | `LearningCycle`, `learning_cycles` |
| **Learning Template** | All non-archived Learning Items in a cycle.                                                                                                             | - (a query, not a table)           |
| **Learning Item**     | One required activity: title, category, CPD type, delivery type, provider, hours, due date, mandatory flag, evidence mode, link, description, audience. | `LearningItem`, `learning_items`   |
| **Audience**          | Who an item applies to: everyone, or any mix of designations and named people.                                                                          | `Audience` value object            |
| **Learning Plan**     | The items whose audience includes a given person, with their status.                                                                                    | `LearningPlan`                     |
| **Completion**        | A person's record of finishing an item: date, reflection, optional evidence. One per person per item; replaceable.                                      | `Completion`, `completions`        |
| **Evidence**          | The certificate / screenshot file attached to a completion.                                                                                             | `EvidenceFile`                     |
| **Evidence Mode**     | `certificate` (file required) or `acknowledgement` (confirm only).                                                                                      | `evidence_mode`                    |
| **Reflection**        | Free-text note on what was learned / applied.                                                                                                           | `reflection`                       |
| **Outstanding**       | Assigned and not completed.                                                                                                                             | `ItemStatus.Outstanding`           |
| **Overdue**           | Outstanding and the due date is before today (Europe/London).                                                                                           | `ItemStatus.Overdue`               |
| **Completion %**      | Completed hours ÷ assigned hours (hours-weighted).                                                                                                      | `LearningProgress`                 |
| **Role**              | `learning_team` (admin), `hr`, `manager`, `team_member`. Controls features.                                                                             | `UserRole`                         |
| **Designation**       | Career level (Junior Accountant … Partner). Used for audiences and default access.                                                                      | `designations`                     |
| **Reporting Access**  | `full` (sees all staff) or `self`.                                                                                                                      | `ReportingAccess`                  |
| **Visibility Scope**  | `all` / `team` / `self` - who a person may see; derived from Role + Reporting Access.                                                                   | `AccessPolicy`                     |
| **Line Manager**      | The person someone reports to. A manager's team = their direct reports.                                                                                 | `line_manager_id`                  |
| **Reminder**          | Email chasing outstanding learning - _automatic_ (scheduled) or _manual_ (sent by the Learning Team).                                                   | `reminder_log`                     |
