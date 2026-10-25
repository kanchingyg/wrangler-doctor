export default {
  name: "broken-worker",
  main: "src/index.ts",
  d1: [
    {
      binding: "DB",
      database_name: "main-db"
    }
  ]
};
