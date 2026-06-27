/**
 * CLI: fire representative inbound timesheets at a running service's dev simulator.
 *
 *   bun run src/simulate.ts [baseUrl]
 *
 * Defaults to http://localhost:8088. Sends a text payout request (TIA case 1 shape), an
 * employee-id text (case 2 shape), and a document + image so you can watch the whole path light up.
 */
export {};

const baseUrl = (process.argv[2] ?? Bun.env.TIA_WA_BASE_URL ?? "http://localhost:8088").replace(
  /\/+$/,
  "",
);

interface Sample {
  readonly label: string;
  readonly body: unknown;
}

const samples: Sample[] = [
  {
    label: "text payout request (case 1 shape - name + client + period + total)",
    body: {
      senderName: "Aldar FinOps",
      messages: [
        {
          from: "971500000001",
          id: `wamid.sim.${Date.now()}.1`,
          type: "text",
          text: {
            body: "Payout request: Carlos Smith, Emirates Steel Industries LLC, June 2026, total AED 9834.13",
          },
        },
      ],
    },
  },
  {
    label: "employee text (case 2 shape - emp id + days, no client)",
    body: {
      messages: [
        {
          from: "971500000002",
          id: `wamid.sim.${Date.now()}.2`,
          type: "text",
          text: { body: "Hi, EMP10093 worked 23 days in June 2026." },
        },
      ],
    },
  },
  {
    label: "document (Excel timesheet)",
    body: {
      messages: [
        {
          from: "971500000003",
          id: `wamid.sim.${Date.now()}.3`,
          type: "document",
          document: {
            id: "MEDIA_SIM_XLSX",
            mime_type:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename: "CL005_June2026_timesheet.xlsx",
            caption: "June timesheet for Majid Al Futtaim",
          },
        },
      ],
    },
  },
  {
    label: "image (handwritten photo)",
    body: {
      messages: [
        {
          from: "971500000004",
          id: `wamid.sim.${Date.now()}.4`,
          type: "image",
          image: { id: "MEDIA_SIM_JPG", mime_type: "image/jpeg", caption: "handwritten register" },
        },
      ],
    },
  },
];

for (const sample of samples) {
  const res = await fetch(`${baseUrl}/internal/simulator/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sample.body),
  });
  const text = await res.text();
  console.log(`\n▶ ${sample.label}`);
  console.log(`  HTTP ${res.status}  ${text}`);
}

console.log("\nDone. Check the service logs and your doc_assets / events for the new rows.");
