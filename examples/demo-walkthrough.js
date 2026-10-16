// Walkthrough for examples/demo.html: type two tasks and add them.
// Render it with:
//   node skills/yokai-render/scripts/render.mjs examples/demo.html \
//     --script examples/demo-walkthrough.js --size 720x720 --fit --pad 16:9 --duration 8

const input = await waitFor('#task');
await sleep(400);

await click(input);
await type('Render the launch video', { into: input });
await sleep(250);
await click('#add');

await sleep(600);
await type('Post it on Friday morning', { into: input });
await sleep(250);
await click('#add');

await sleep(400);
pointer.place(innerWidth * 0.75, innerHeight * 0.8, 700);
