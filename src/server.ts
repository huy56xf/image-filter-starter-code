import express,{Request, Response} from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import {filterImageFromURL, deleteLocalFiles} from './util/util';
import {scanImage, SCAN_MODES, ScanMode} from './util/scanner';

(async () => {

  // Init the Express application
  const app = express();

  // Set the network port
  const port = process.env.PORT || 8082;
  
  // Use the body parser middleware for post requests
  app.use(bodyParser.json());

  // @TODO1 IMPLEMENT A RESTFUL ENDPOINT
  // GET /filteredimage?image_url={{URL}}


  app.get("/filteredimage", async(req: Request, res: Response) => {
    let {image_url} = req.query;
    if (!image_url){
      res.status(400).send('Error: The submitted url is empty');
    } 
    else {
      await filterImageFromURL(image_url).then
        ( function (image_filtered_path){
           res.sendFile(image_filtered_path, () => 
             {       
               deleteLocalFiles([image_filtered_path]);
              }
                       );   
                            }
        ).catch(function(err){
            res.status(501).send('Error:' + err );
                              });  

          }
  });


  // endpoint to filter an image from a public url.
  // IT SHOULD
  //    1
  //    1. validate the image_url query
  //    2. call filterImageFromURL(image_url) to filter the image
  //    3. send the resulting file in the response
  //    4. deletes any files on the server on finish of the response
  // QUERY PARAMATERS
  //    image_url: URL of a publicly accessible image
  // RETURNS
  //   the filtered image file [!!TIP res.sendFile(filteredpath); might be useful]

  /**************************************************************************** */

  //! END @TODO1
  
  // ---------------------------------------------------------------------------
  // Ứng dụng quét tài liệu (Document Scanner)
  // ---------------------------------------------------------------------------

  function parseMode(m: any): ScanMode {
    return SCAN_MODES.indexOf(m) >= 0 ? m : "magic";
  }

  async function sendScan(res: Response, input: Buffer | string, mode: ScanMode) {
    try {
      const out = await scanImage(input, mode);
      res.set("Content-Type", out.mime);
      res.set("X-Document-Found", String(out.found));
      res.set("X-Document-Confidence", String(out.confidence));
      res.set("X-Document-Corners", JSON.stringify(out.corners.map(c => [Math.round(c.x), Math.round(c.y)])));
      res.send(out.buffer);
    } catch (err) {
      res.status(422).send("Error: cannot scan image - " + (err && (err as Error).message));
    }
  }

  // GET /scan?image_url={{URL}}&mode=magic|gray|bw|original
  // Tải ảnh từ URL, tự nhận diện tờ giấy và trả về bản scan.
  app.get("/scan", async (req: Request, res: Response) => {
    const { image_url, mode } = req.query as any;
    if (!image_url) {
      return res.status(400).send("Error: image_url query parameter is required");
    }
    await sendScan(res, String(image_url), parseMode(mode));
  });

  // POST /scan?mode=...  (body: dữ liệu ảnh nhị phân, Content-Type: image/*)
  // vd: curl --data-binary @photo.jpg -H "Content-Type: image/jpeg" localhost:8082/scan -o scan.jpg
  app.post("/scan", bodyParser.raw({ type: "image/*", limit: "25mb" }), async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).send("Error: send the image as the request body with Content-Type image/*");
    }
    await sendScan(res, req.body, parseMode((req.query as any).mode));
  });

  // Giao diện web (public/index.html): chụp/chọn ảnh, chỉnh góc, bộ lọc, xuất PDF
  app.use(express.static(path.join(__dirname, "..", "public")));
  

  // Start the Server
  app.listen( port, () => {
      console.log( `server running http://localhost:${ port }` );
      console.log( `press CTRL+C to stop server` );
  } );
})();
