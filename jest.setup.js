// Custom serializer for BigInt in Jest
expect.addSnapshotSerializer({
  test: (val) => typeof val === 'bigint',
  print: (val) => `BigInt(${val}n)`,
});
