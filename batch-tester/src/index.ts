require("dotenv").config()
import express from "express"
import cors from "cors"
import { routeExtract } from "./routes/extract"
import { JobsFactory } from "./Services/JobsFactory"

const main = async () => {
  // start express instance
  const app = express()
  app.use(express.json())
  app.use(cors())

  // init modules
  JobsFactory.init()

  // runs a job on the GPU to extract any data
  routeExtract(app)

  app.listen(process.env.PORT, () => {
    console.log("-----------------------")
    console.log("-----------------------")
    console.log(`🟢  server listening on port ${process.env.PORT}`)
    console.log("-----------------------")
    console.log("-----------------------")
  })
}
main()