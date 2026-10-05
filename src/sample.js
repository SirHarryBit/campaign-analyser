/* Example data for a fictional business ("Lakeside Yoga Studio"). Not real campaigns. */
(function (root) {
  const SAMPLE_CSV = [
    'Campaign name,Platform,Objective,Reporting starts,Reporting ends,Budget,Amount spent (INR),Impressions,Reach,Link clicks,Landing page views,Leads,Qualified leads,Audience size,Targeting',
    'Example – Open audience lead form,Meta,Leads,2026-08-01,2026-08-21,60000,58200,512000,201000,6140,,412,78,24000000,Advantage+ audience; Mumbai 25-45',
    'Example – Wellness interests,Meta,Leads,2026-08-01,2026-08-21,60000,59100,318000,142000,4370,3010,264,121,3800000,Interests: yoga + meditation + fitness',
    'Example – Lookalike of members,Meta,Leads,2026-08-05,2026-08-25,40000,31800,151000,48500,2390,1820,151,96,520000,1% lookalike of members list',
    'Example – Studio launch reel,Meta,Awareness,2026-08-01,2026-08-10,15000,14900,690000,262000,1880,,,,9500000,Mumbai 22-50 broad interests',
  ].join('\n');
  root.SAMPLE_CSV = SAMPLE_CSV;
  if (typeof module !== 'undefined' && module.exports) module.exports = { SAMPLE_CSV };
})(typeof window !== 'undefined' ? window : globalThis);
